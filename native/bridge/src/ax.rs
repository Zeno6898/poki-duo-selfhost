use super::Result;
use idevice::{
    ReadWrite,
    dvt::message::{Aux, AuxHeader, AuxValue, Message, MessageHeader, PayloadHeader},
    rsd::RsdHandshake,
    tcp::handle::AdapterHandle,
};
use plist::Value;
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashSet};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

// The first DTX auxiliary argument carries the archived NSData payload.
// The handshake advertises capabilities before subscribing to accessibility:
// capabilities {DTXBlockCompression:0, DTXConnection:1}, then clientNeedsAccessibility:true.
// A phone sends attribute 28 only in a second, fuller tree that arrives after this reader has
// returned. Trait bit 21 (AXTraitIsEditing in idb's AXTraits.h) is in the first tree too.
pub(crate) fn is_editing(traits: u64) -> bool {
    traits & (1 << 21) != 0
}

pub async fn read_tree(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    include_offscreen: bool,
) -> Result<Json> {
    read_tree_with_timeout(adapter, rsd, include_offscreen, Duration::from_secs(20)).await
}

// A subscription made while the screen is changing is often never answered, while one made a moment
// later is answered in about a second. The wait is therefore spent on fresh subscriptions.
const ANSWER_WITHIN: Duration = Duration::from_millis(2000);

pub async fn read_tree_with_timeout(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    include_offscreen: bool,
    wait: Duration,
) -> Result<Json> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let answer = subscribe(adapter, rsd, include_offscreen, remaining.min(ANSWER_WITHIN)).await?;
        if let Some(tree) = answer {
            return Ok(tree);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Native accessibility tree did not arrive within {} seconds",
                wait.as_secs()
            )
            .into());
        }
    }
}

// One subscription; None when it was not answered within `wait`.
async fn subscribe(
    adapter: &mut AdapterHandle,
    rsd: &RsdHandshake,
    include_offscreen: bool,
    wait: Duration,
) -> Result<Option<Json>> {
    let port = rsd
        .services
        .get("com.apple.accessibility.axAuditDaemon.remoteAXService")
        .ok_or("Native accessibility service is unavailable")?
        .port;
    let mut socket = adapter.connect(port).await?;
    let mut capabilities = plist::Dictionary::new();
    capabilities.insert("com.apple.private.DTXBlockCompression".into(), 0.into());
    capabilities.insert("com.apple.private.DTXConnection".into(), 1.into());
    call(
        &mut socket,
        1,
        "_notifyOfPublishedCapabilities:",
        Value::Dictionary(capabilities),
        false,
    )
    .await?;
    call(
        &mut socket,
        2,
        "clientNeedsAccessibility:",
        true.into(),
        true,
    )
    .await?;
    let result = tokio::time::timeout(wait, async {
        let mut tree = Tree {
            include_offscreen,
            ..Tree::default()
        };
        loop {
            let message = Message::from_reader(&mut socket).await?;
            acknowledge(&mut socket, &message).await?;
            if let Some(aux) = message.aux.as_ref() {
                if let Some(AuxValue::Array(bytes)) = aux.values.first() {
                    if let Ok(archive) = Archive::parse(bytes) {
                        if let Some(data) = archive.data(archive.root()) {
                            tree.update(&Archive::parse(data)?)?;
                            if tree.ready() {
                                return Ok::<Json, Box<dyn std::error::Error + Send + Sync>>(
                                    tree.json(),
                                );
                            }
                        }
                    }
                }
            }
        }
    })
    .await;
    let _ = call(
        &mut socket,
        3,
        "clientNeedsAccessibility:",
        false.into(),
        true,
    )
    .await;
    let _ = socket.shutdown().await;
    result.ok().transpose()
}

// AX archives contain custom classes. Keep UIDs intact and resolve only fields
// we consume; a generic NSObject decoder loses the translation-object graph.
struct Archive {
    value: Value,
}
impl Archive {
    fn parse(bytes: &[u8]) -> Result<Self> {
        let value = Value::from_reader(std::io::Cursor::new(bytes))?;
        if value
            .as_dictionary()
            .and_then(|d| d.get("$objects"))
            .and_then(Value::as_array)
            .is_none()
        {
            return Err("AX message is not a keyed archive".into());
        }
        Ok(Self { value })
    }
    fn resolve<'a>(&'a self, mut value: &'a Value) -> &'a Value {
        let objects = self.value.as_dictionary().unwrap()["$objects"]
            .as_array()
            .unwrap();
        for _ in 0..32 {
            let Some(uid) = value.as_uid() else { break };
            let Some(next) = objects.get(uid.get() as usize) else {
                break;
            };
            value = next;
        }
        value
    }
    fn root(&self) -> &Value {
        let d = self.value.as_dictionary().unwrap();
        self.resolve(
            d.get("$top")
                .and_then(Value::as_dictionary)
                .and_then(|v| v.get("root"))
                .unwrap_or(&self.value),
        )
    }
    fn field<'a>(&'a self, value: &'a Value, name: &str) -> Option<&'a Value> {
        let d = self.resolve(value).as_dictionary()?;
        if let Some(v) = d.get(name) {
            return Some(self.resolve(v));
        }
        self.entries(value)
            .into_iter()
            .find(|(key, _)| self.string(key).as_deref() == Some(name))
            .map(|(_, v)| v)
    }
    fn entries<'a>(&'a self, value: &'a Value) -> Vec<(&'a Value, &'a Value)> {
        let Some(d) = self.resolve(value).as_dictionary() else {
            return vec![];
        };
        let Some(keys) = d.get("NS.keys").map(|v| self.array(v)) else {
            return vec![];
        };
        let Some(vals) = d.get("NS.objects").map(|v| self.array(v)) else {
            return vec![];
        };
        keys.into_iter().zip(vals).collect()
    }
    fn array<'a>(&'a self, value: &'a Value) -> Vec<&'a Value> {
        let value = self.resolve(value);
        let values = value
            .as_array()
            .or_else(|| value.as_dictionary()?.get("NS.objects")?.as_array());
        values
            .map(|a| a.iter().map(|v| self.resolve(v)).collect())
            .unwrap_or_default()
    }
    fn string(&self, value: &Value) -> Option<String> {
        let value = self.resolve(value);
        if let Some(v) = value.as_string() {
            return (v != "$null").then(|| v.to_owned());
        }
        let d = value.as_dictionary()?;
        for key in [
            "NS.string",
            "NS.relative",
            "NS.rectval",
            "NS.pointval",
            "NS.sizeval",
        ] {
            if let Some(s) = d.get(key).and_then(|v| self.resolve(v).as_string()) {
                return Some(s.to_owned());
            }
        }
        None
    }
    fn number(&self, value: &Value) -> Option<f64> {
        let value = self.resolve(value);
        value
            .as_signed_integer()
            .map(|v| v as f64)
            .or_else(|| value.as_unsigned_integer().map(|v| v as f64))
            .or_else(|| value.as_real())
            .or_else(|| value.as_boolean().map(|v| if v { 1.0 } else { 0.0 }))
    }
    fn integer(&self, value: &Value) -> Option<u64> {
        let value = self.resolve(value);
        value
            .as_unsigned_integer()
            .or_else(|| value.as_signed_integer().and_then(|v| v.try_into().ok()))
            .or_else(|| self.number(value).map(|v| v as u64))
    }
    fn data<'a>(&'a self, value: &'a Value) -> Option<&'a [u8]> {
        self.resolve(value)
            .as_data()
            .or_else(|| self.field(value, "NS.data").and_then(Value::as_data))
    }
    fn numbers(&self, value: &Value) -> Vec<f64> {
        self.string(value)
            .unwrap_or_default()
            .split(|c: char| {
                !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')
            })
            .filter_map(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite())
            .collect()
    }
}

#[derive(Default)]
struct Node {
    fields: Map<String, Json>,
    children: Vec<u64>,
    visible_children: Vec<u64>,
}
#[derive(Default)]
struct Tree {
    nodes: BTreeMap<u64, Node>,
    roots: Vec<(u64, Option<u64>)>,
    orientation: Option<u64>,
    include_offscreen: bool,
}
impl Tree {
    fn update(&mut self, a: &Archive) -> Result<()> {
        let root = a.root();
        if a.field(root, "associatedRequestType")
            .and_then(|v| a.integer(v))
            != Some(11)
        {
            return Ok(());
        }
        let Some(result) = a.field(root, "resultData") else {
            return Ok(());
        };
        let Some(dump) = a.field(result, "treeDump") else {
            return Ok(());
        };
        let roles: Vec<String> = serde_json::from_str(include_str!("roles.json"))?;
        for response in a.array(dump) {
            let kind = a
                .field(response, "associatedRequestType")
                .and_then(|v| a.integer(v));
            let Some(data) = a.field(response, "resultData") else {
                continue;
            };
            match kind {
                Some(4) => {
                    if let Some(id) = a.field(data, "objectID").and_then(|v| a.integer(v)) {
                        let pid = a.field(data, "pid").and_then(|v| a.integer(v));
                        if !self.roots.iter().any(|(r, _)| *r == id) {
                            self.roots.push((id, pid));
                        }
                    }
                }
                Some(2)
                    if a.field(response, "attribute").and_then(|v| a.integer(v)) == Some(129) =>
                {
                    self.orientation = a.integer(data);
                }
                Some(5) => {
                    let Some(id) = a
                        .field(response, "associatedTranslationObject")
                        .and_then(|v| a.field(v, "objectID"))
                        .and_then(|v| a.integer(v))
                    else {
                        continue;
                    };
                    let node = self.nodes.entry(id).or_default();
                    for (key, value) in a.entries(data) {
                        let Some(attribute) = a.integer(key) else {
                            continue;
                        };
                        match attribute {
                            3 | 6 | 23 | 25 | 33 | 42 | 53 | 120 => {
                                let name = match attribute {
                                    3 | 33 => "label",
                                    6 => "bundle_id",
                                    23 => "hint",
                                    25 => "identifier",
                                    42 => "placeholder",
                                    53 => "value",
                                    _ => "url",
                                };
                                if attribute == 3 && node.fields.contains_key("label") {
                                    continue;
                                }
                                let text = a
                                    .string(value)
                                    .or_else(|| a.number(value).map(|v| v.to_string()));
                                if let Some(text) = text {
                                    node.fields.insert(name.into(), text.into());
                                }
                            }
                            8 | 9 => {
                                let ids = a
                                    .array(value)
                                    .into_iter()
                                    .filter_map(|v| {
                                        a.integer(v).or_else(|| {
                                            a.field(v, "objectID").and_then(|v| a.integer(v))
                                        })
                                    })
                                    .collect();
                                if attribute == 8 {
                                    node.children = ids;
                                } else {
                                    node.visible_children = ids;
                                }
                            }
                            1 | 21 => {
                                let n = a.numbers(value);
                                if attribute == 21 && n.len() == 4 {
                                    node.fields.insert(
                                        "frame".into(),
                                        json!({"x":n[0],"y":n[1],"width":n[2],"height":n[3]}),
                                    );
                                }
                                if attribute == 1 && n.len() == 2 {
                                    node.fields.insert(
                                        "activation_point".into(),
                                        json!({"x":n[0],"y":n[1]}),
                                    );
                                }
                            }
                            22 | 45 | 61 | 77 => {
                                if let Some(n) = a.integer(value) {
                                    let name = match attribute {
                                        22 => "header_level",
                                        45 => "accessibility_role",
                                        61 => "element_type",
                                        _ => "traits",
                                    };
                                    node.fields.insert(name.into(), n.into());
                                    if attribute == 61 {
                                        node.fields.insert(
                                            "role".into(),
                                            roles
                                                .get(n as usize)
                                                .map(|s| json!(s))
                                                .unwrap_or(json!("Other")),
                                        );
                                    }
                                }
                            }
                            26 | 27 | 28 | 30 | 119 => {
                                if let Some(n) = a.number(value) {
                                    let name = match attribute {
                                        26 => "is_accessibility_element",
                                        27 => "enabled",
                                        28 => "focused",
                                        30 => "selected",
                                        _ => "accessibility_attribute_119",
                                    };
                                    node.fields.insert(name.into(), (n != 0.0).into());
                                }
                            }
                            78 => {
                                node.fields.insert(
                                    "trait_names".into(),
                                    json!(
                                        a.array(value)
                                            .into_iter()
                                            .filter_map(|v| a.string(v))
                                            .collect::<Vec<_>>()
                                    ),
                                );
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn ready(&self) -> bool {
        !self.roots.is_empty()
            && self.roots.iter().any(|(id, _)| self.nodes.contains_key(id))
            && self.nodes.len() > 1
    }
    fn json(&self) -> Json {
        let mut elements = vec![];
        let mut visited = HashSet::new();
        let mut stack: Vec<(u64, Option<usize>, usize)> = self
            .roots
            .iter()
            .rev()
            .map(|(id, _)| (*id, None, 0))
            .collect();
        while let Some((id, parent, depth)) = stack.pop() {
            if !visited.insert(id) {
                continue;
            }
            let Some(node) = self.nodes.get(&id) else {
                continue;
            };
            let index = elements.len();
            let mut fields = node.fields.clone();
            let role = self.role(id, node);
            fields.insert("role".into(), role.into());
            if !fields.contains_key("trait_names") {
                let traits = fields.get("traits").and_then(Json::as_u64).unwrap_or(0);
                let names: Vec<(u32, String)> =
                    serde_json::from_str(include_str!("traits.json")).unwrap();
                fields.insert(
                    "trait_names".into(),
                    json!(
                        names
                            .into_iter()
                            .filter(|(bit, _)| traits & (1u64 << bit) != 0)
                            .map(|(_, name)| name)
                            .collect::<Vec<_>>()
                    ),
                );
            }
            if let Some(traits) = fields.get("traits").and_then(Json::as_u64) {
                fields.insert("focused".into(), is_editing(traits).into());
            }
            fields.insert("object_id".into(), format!("o{id}").into());
            fields.insert("parent".into(), json!(parent));
            fields.insert("depth".into(), depth.into());
            let children = if (self.include_offscreen && !node.children.is_empty())
                || node.visible_children.is_empty()
            {
                &node.children
            } else {
                &node.visible_children
            };
            for child in children.iter().rev() {
                stack.push((*child, Some(index), depth + 1));
            }
            elements.push(Json::Object(fields));
        }
        let applications:Vec<Json>=self.roots.iter().filter_map(|(id,pid)|{
            let node=self.nodes.get(id)?;
            Some(json!({"object_id":format!("o{id}"),"name":node.fields.get("label"),"bundle_id":node.fields.get("bundle_id"),"pid":pid}))
        }).collect();
        let foreground = if applications.len() == 1 {
            applications.first().cloned()
        } else {
            None
        };
        json!({"source":"accessibility","elements":elements,"applications":applications,"foreground_app":foreground,"orientation":self.orientation})
    }
    // Prefer explicit roles before applying the fallback role table.
    fn role(&self, id: u64, node: &Node) -> String {
        if self.roots.iter().any(|(root, _)| *root == id) {
            return "Application".into();
        }
        if let Some(role) = node.fields.get("role").and_then(Json::as_str) {
            if role != "Any" && role != "Other" {
                return role.into();
            }
        }
        let traits = node
            .fields
            .get("traits")
            .and_then(Json::as_u64)
            .unwrap_or(0);
        for (bit, role) in [
            (5, "Key"),
            (10, "SearchField"),
            (18, "TextField"),
            (53, "Switch"),
            (12, "Adjustable"),
            (1, "Link"),
            (0, "Button"),
        ] {
            if traits & (1 << bit) != 0 {
                return role.into();
            }
        }
        if let Some(role) = node
            .fields
            .get("accessibility_role")
            .and_then(Json::as_u64)
            .and_then(|v| match v {
                2 => Some("Button"),
                3 => Some("Switch"),
                6 | 14 => Some("StaticText"),
                8 => Some("Link"),
                13 => Some("Adjustable"),
                15 => Some("TextField"),
                _ => None,
            })
        {
            return role.into();
        }
        for (bit, role) in [
            (15, "TabBar"),
            (2, "Image"),
            (6, "StaticText"),
            (16, "StaticText"),
        ] {
            if traits & (1 << bit) != 0 {
                return role.into();
            }
        }
        "Other".into()
    }
}

async fn call(
    socket: &mut impl ReadWrite,
    id: u32,
    selector: &str,
    argument: Value,
    reply: bool,
) -> Result<()> {
    let message = Message::new(
        MessageHeader::new(0, 1, id, 0, 0, reply),
        PayloadHeader::method_invocation(),
        Some(Aux {
            header: AuxHeader::default(),
            values: vec![AuxValue::archived_value(argument)],
        }),
        Some(selector.into()),
    );
    let bytes = message.serialize();
    socket.write_all(&bytes).await?;
    Ok(())
}

async fn acknowledge(socket: &mut impl ReadWrite, message: &Message) -> Result<()> {
    let header = message.message_header.serialize();
    let word = |offset| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
    if word(28) == 0 {
        return Ok(());
    }
    let reply = Message::new(
        MessageHeader::new(
            0,
            1,
            word(16),
            word(20) + 1,
            -message.message_header.channel,
            false,
        ),
        PayloadHeader::default(),
        None,
        None,
    );
    socket.write_all(&reply.serialize()).await?;
    Ok(())
}
