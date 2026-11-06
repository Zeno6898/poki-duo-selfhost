//! A persistent OCR worker for the live screen (workstream J1, fork-only).
//!
//! build/ocr starts Python and loads RapidOCR's models on every call, which costs about a second
//! before any reading starts. The daemon instead keeps one worker (ocr_worker.py, run with the same
//! interpreter) and sends it one request per line, so a field-sized box reads in about 100 ms and
//! a whole screen in about 300 to 400 ms.
//!
//! The interpreter is POKI_OCR_PYTHON, else `ocr-venv/bin/python` beside the daemon binary (what
//! bin/build-native makes on Linux). Without one, OCR is unavailable and callers fall back.
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const WORKER: &str = include_str!("ocr_worker.py");

fn log(message: &str) {
    eprintln!("{} poki-bridged: {message}", crate::ax::watch::stamp());
}
/// Model loading and a warm-up read, on a cold disk.
const START_LIMIT: Duration = Duration::from_secs(60);

/// One recognised line, in pixels of the whole picture.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Element {
    pub text: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug)]
pub struct Reading {
    pub elements: Vec<Element>,
    pub size: (f64, f64),
    pub ms: f64,
}

impl Reading {
    /// The lines joined with spaces, in the engine's reading order (top to bottom).
    pub fn text(&self) -> String {
        self.elements
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Elements as fractions of the screen, the unit of the feed's regions.
    pub fn json(&self) -> Value {
        let (w, h) = (self.size.0.max(1.0), self.size.1.max(1.0));
        let round = |v: f64| (v * 10000.0).round() / 10000.0;
        Value::Array(
            self.elements
                .iter()
                .map(|e| {
                    json!({
                        "text": e.text,
                        "confidence": (e.confidence * 1000.0).round() / 1000.0,
                        "region": [round(e.x / w), round(e.y / h), round(e.width / w), round(e.height / h)],
                        "center": [round((e.x + e.width / 2.0) / w), round((e.y + e.height / 2.0) / h)],
                    })
                })
                .collect(),
        )
    }
}

struct Worker {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

pub struct Ocr {
    python: Option<PathBuf>,
    worker: tokio::sync::Mutex<Option<Worker>>,
    next: Cell<u64>,
    reads: Cell<u64>,
    last_error: RefCell<Option<String>>,
}

thread_local! {
    static SHARED: Rc<Ocr> = Rc::new(Ocr::new(interpreter()));
}

/// The daemon's worker (the daemon runs on one thread).
pub fn shared() -> Rc<Ocr> {
    SHARED.with(Rc::clone)
}

fn interpreter() -> Option<PathBuf> {
    if let Some(python) = std::env::var_os("POKI_OCR_PYTHON").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(python));
    }
    let beside = std::env::current_exe()
        .ok()?
        .parent()?
        .join("ocr-venv/bin/python");
    beside.exists().then_some(beside)
}

impl Ocr {
    pub fn new(python: Option<PathBuf>) -> Self {
        Self {
            python,
            worker: tokio::sync::Mutex::new(None),
            next: Cell::new(0),
            reads: Cell::new(0),
            last_error: RefCell::new(None),
        }
    }

    pub fn available(&self) -> bool {
        self.python.is_some()
    }

    pub fn stats(&self) -> Value {
        json!({
            "available": self.available(),
            "running": self.worker.try_lock().map_or(true, |w| w.is_some()),
            "reads": self.reads.get(),
            "last_error": *self.last_error.borrow(),
        })
    }

    /// Starts the worker ahead of the first read.
    pub async fn warm(&self) {
        if !self.available() {
            return;
        }
        let mut worker = self.worker.lock().await;
        if worker.is_none() {
            match self.start().await {
                Ok(started) => *worker = Some(started),
                Err(error) => self.note_error(&*error),
            }
        }
    }

    async fn start(&self) -> Result<Worker> {
        let python = self.python.as_ref().ok_or("no OCR interpreter")?;
        let at = Instant::now();
        let mut child = tokio::process::Command::new(python)
            .arg("-I")
            .arg("-c")
            .arg(WORKER)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().ok_or("no worker stdin")?;
        let mut lines = BufReader::new(child.stdout.take().ok_or("no worker stdout")?).lines();
        let ready = tokio::time::timeout(START_LIMIT, lines.next_line())
            .await
            .map_err(|_| "the OCR worker did not start within 60 s")??
            .ok_or("the OCR worker exited while starting")?;
        if serde_json::from_str::<Value>(&ready)?["ready"] != json!(true) {
            return Err(format!("unexpected OCR worker start line: {ready}").into());
        }
        log(&format!(
            "ocr: worker ready in {} ms",
            at.elapsed().as_millis()
        ));
        Ok(Worker {
            child,
            stdin,
            lines,
        })
    }

    fn note_error(&self, error: &(dyn std::error::Error + Send + Sync)) {
        log(&format!("ocr: {error}"));
        *self.last_error.borrow_mut() = Some(error.to_string());
    }

    /// Reads an image file, or the `region` of it ([x, y, w, h] as fractions).
    pub async fn read(
        &self,
        path: &Path,
        region: Option<[f64; 4]>,
        limit: Duration,
    ) -> Result<Reading> {
        if !self.available() {
            return Err("OCR is unavailable: set POKI_OCR_PYTHON or build build/ocr-venv".into());
        }
        let mut worker = self.worker.lock().await;
        if worker.is_none() {
            *worker = Some(self.start().await.inspect_err(|e| self.note_error(&**e))?);
        }
        let id = self.next.get() + 1;
        self.next.set(id);
        let request = json!({"id": id, "path": path, "box": region});
        let running = worker.as_mut().expect("started");
        let answer = tokio::time::timeout(limit, async {
            let mut line = request.to_string();
            line.push('\n');
            running.stdin.write_all(line.as_bytes()).await?;
            running.stdin.flush().await?;
            loop {
                let line = running
                    .lines
                    .next_line()
                    .await?
                    .ok_or("the OCR worker exited")?;
                let answer: Value = serde_json::from_str(&line)?;
                // A late answer to a request that timed out earlier.
                if answer["id"] == json!(id) {
                    return Ok::<Value, Box<dyn std::error::Error + Send + Sync>>(answer);
                }
            }
        })
        .await;
        let answer = match answer {
            Ok(Ok(answer)) => answer,
            failed => {
                // A worker that timed out or broke may be stuck: start a new one next time.
                if let Some(mut broken) = worker.take() {
                    let _ = broken.child.start_kill();
                }
                let error: Box<dyn std::error::Error + Send + Sync> = match failed {
                    Ok(Err(error)) => error,
                    _ => format!("OCR took longer than {} ms", limit.as_millis()).into(),
                };
                self.note_error(&*error);
                return Err(error);
            }
        };
        if let Some(error) = answer["error"].as_str() {
            return Err(error.to_owned().into());
        }
        self.reads.set(self.reads.get() + 1);
        let elements: Vec<Element> = serde_json::from_value(answer["elements"].clone())?;
        let size = &answer["size"];
        Ok(Reading {
            elements,
            size: (
                size[0].as_f64().unwrap_or(1.0),
                size[1].as_f64().unwrap_or(1.0),
            ),
            ms: answer["ms"].as_f64().unwrap_or(0.0),
        })
    }

    /// Reads the newest live picture, or the `region` of it.
    pub async fn read_live(
        &self,
        live: &crate::frames::Live,
        region: Option<[f64; 4]>,
        limit: Duration,
    ) -> Result<(Reading, crate::frames::Jpeg)> {
        // Full size at the best quality: OCR wants every pixel of small text.
        let jpeg = live.jpeg(4096, 2).await?;
        let path = std::env::temp_dir().join(format!(
            "poki-bridged-ocr-{}-{}.jpg",
            std::process::id(),
            self.next.get() + 1
        ));
        tokio::fs::write(&path, &jpeg.bytes).await?;
        let reading = self.read(&path, region, limit).await;
        let _ = tokio::fs::remove_file(&path).await;
        Ok((reading?, jpeg))
    }
}

/// The fewest edits that turn `needle` into some run of `haystack` (semi-global edit distance):
/// how far an OCR reading is from containing the expected text.
pub fn distance_within(needle: &str, haystack: &str) -> usize {
    let needle: Vec<char> = needle.chars().collect();
    let haystack: Vec<char> = haystack.chars().collect();
    if needle.is_empty() {
        return 0;
    }
    // previous[j]: the cost of matching needle[..i] ending at haystack[..j]; starting anywhere is free.
    let mut previous = vec![0usize; haystack.len() + 1];
    for (i, n) in needle.iter().enumerate() {
        let mut current = vec![i + 1; haystack.len() + 1];
        for (j, h) in haystack.iter().enumerate() {
            let substitute = previous[j] + usize::from(n != h);
            current[j + 1] = substitute.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        previous = current;
    }
    previous.into_iter().min().unwrap_or(needle.len())
}

/// Lowercase with runs of whitespace as one space: OCR's spacing and case are not reliable.
pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Whether `reading` shows `expected`, allowing one OCR slip per ten characters. For text longer
/// than the field can show, its end is what stays in view.
pub fn shows(reading: &str, expected: &str) -> bool {
    let (reading, expected) = (normalize(reading), normalize(expected));
    if expected.is_empty() {
        return false;
    }
    let tail: String = {
        let chars: Vec<char> = expected.chars().collect();
        chars[chars.len().saturating_sub(40)..].iter().collect()
    };
    let allowed = (tail.chars().count() / 10)
        .max(1)
        .min(tail.chars().count() / 3);
    distance_within(&tail, &reading) <= allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_text_is_found_through_ocr_slips() {
        assert_eq!(distance_within("abc", "xxabcxx"), 0);
        assert_eq!(distance_within("abc", "xxabxx"), 1);
        assert!(shows("Groceries for Sunday", "groceries for sunday"));
        assert!(shows(
            "Notes  Groceries fer Sunday 12:41",
            "Groceries for Sunday"
        ));
        assert!(!shows("Groceries", "Groceries for Sunday"));
        assert!(!shows("", "a"));
        assert!(!shows("b", "a"), "one character allows no slip");
        // Long text: only its end has to be in view.
        let long = "word ".repeat(30) + "the final words typed";
        assert!(shows("word word word the final words typed|", &long));
    }

    /// The worker against the real engine, when a test interpreter is given.
    #[test]
    fn the_worker_reads_a_box_and_a_whole_image() {
        let Some(python) = std::env::var_os("POKI_OCR_TEST_PYTHON").filter(|p| !p.is_empty())
        else {
            eprintln!("skipped: set POKI_OCR_TEST_PYTHON to an interpreter with rapidocr");
            return;
        };
        let image = std::env::var_os("POKI_OCR_TEST_IMAGE").expect("POKI_OCR_TEST_IMAGE");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let ocr = Ocr::new(Some(python.into()));
            ocr.warm().await;
            let started = Instant::now();
            let boxed = ocr
                .read(
                    Path::new(&image),
                    Some([0.04, 0.15, 0.92, 0.05]),
                    Duration::from_secs(5),
                )
                .await
                .unwrap();
            let box_ms = started.elapsed().as_millis();
            let started = Instant::now();
            let whole = ocr
                .read(Path::new(&image), None, Duration::from_secs(5))
                .await
                .unwrap();
            let whole_ms = started.elapsed().as_millis();
            eprintln!(
                "box {box_ms} ms: {:?}; whole {whole_ms} ms: {:?}",
                boxed.text(),
                whole.text()
            );
            assert!(shows(&boxed.text(), "Groceries for Sunday"));
            assert!(shows(&whole.text(), "Another line of text"));
            assert!(
                ocr.read(Path::new("/nonexistent.jpg"), None, Duration::from_secs(5))
                    .await
                    .is_err()
            );
            // An error answer leaves the worker running.
            assert!(
                ocr.read(Path::new(&image), None, Duration::from_secs(5))
                    .await
                    .is_ok()
            );
        });
    }
}
