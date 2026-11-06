//! Back-off for the phone's accessibility service (fork-only).
//!
//! Nov 6: after an evening of held subscriptions and retries the phone's accessibility service
//! stopped answering anyone (a separate poki-native on its own tunnel got an empty tree after
//! 21 s), and every op that wanted a tree held the session for 4 to 21 s. One gate now covers
//! every read (the held watch, its fallback, the prefetch): one at a time, and after
//! FAILURES_BEFORE_PAUSE unanswered reads in a row none is sent until a back-off ends (1 s,
//! doubling, at most MAX_PAUSE). Reads during the pause fail at once with the reason, so taps,
//! pictures and OCR keep their speed. The first read after a pause opens fresh connections (the
//! daemon drops the held subscription when the gate closes).
use super::*;

pub const FAILURES_BEFORE_PAUSE: u32 = 3;
pub const MAX_PAUSE: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct AxGate {
    failures: u32,
    unavailable_since: Option<std::time::SystemTime>,
    paused_until: Option<Instant>,
    pauses: u32,
    last_error: Option<String>,
    /// One read at a time, whoever sends it.
    pub(crate) one: Rc<tokio::sync::Mutex<()>>,
}

pub type AxGateCell = Rc<std::cell::RefCell<AxGate>>;

impl AxGate {
    /// Why no read may be sent now, if none may.
    pub fn closed(&self, now: Instant) -> Option<String> {
        let until = self.paused_until.filter(|until| now < *until)?;
        Some(format!(
            "accessibility unavailable: {} reads in a row went unanswered (last: {}); next try in {} ms",
            self.failures,
            self.last_error.as_deref().unwrap_or("no answer"),
            until.duration_since(now).as_millis()
        ))
    }

    pub fn succeeded(&mut self) {
        if self.unavailable_since.is_some() {
            log("accessibility answers again");
        }
        self.failures = 0;
        self.unavailable_since = None;
        self.paused_until = None;
        self.pauses = 0;
    }

    /// Records an unanswered read; whether the gate closed now (drop held connections then).
    pub fn failed(&mut self, error: &str, now: Instant) -> bool {
        self.failures += 1;
        self.last_error = Some(error.chars().take(200).collect());
        if self.failures < FAILURES_BEFORE_PAUSE {
            return false;
        }
        let pause = Duration::from_secs(1u64 << self.pauses.min(5)).min(MAX_PAUSE);
        self.pauses += 1;
        self.paused_until = Some(now + pause);
        self.unavailable_since
            .get_or_insert_with(std::time::SystemTime::now);
        log(&format!(
            "accessibility: {} unanswered reads in a row; pausing reads for {} s",
            self.failures,
            pause.as_secs()
        ));
        true
    }

    pub fn unavailable(&self) -> bool {
        self.unavailable_since.is_some()
    }

    pub fn json(&self) -> Value {
        let now = Instant::now();
        json!({
            "unavailable": self.unavailable(),
            "since": self.unavailable_since.map(crate::ax::watch::stamp_at),
            "failures_in_a_row": self.failures,
            "pauses": self.pauses,
            "next_try_ms": self.paused_until.filter(|u| now < *u).map(|u| u.duration_since(now).as_millis() as u64),
            "last_error": self.last_error,
        })
    }
}

/// Runs one accessibility read through the gate: refused at once while paused, one at a time,
/// and its outcome recorded. `closed_now` is called when this failure closed the gate.
pub async fn through<T>(
    gate: &AxGateCell,
    read: impl std::future::Future<Output = Result<T>>,
    closed_now: impl FnOnce(),
) -> Result<T> {
    if let Some(reason) = gate.borrow().closed(Instant::now()) {
        return Err(reason.into());
    }
    let one = gate.borrow().one.clone();
    let _turn = one.lock().await;
    if let Some(reason) = gate.borrow().closed(Instant::now()) {
        return Err(reason.into());
    }
    let result = read.await;
    match &result {
        Ok(_) => gate.borrow_mut().succeeded(),
        Err(error) => {
            if gate.borrow_mut().failed(&error.to_string(), Instant::now()) {
                closed_now();
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_unanswered_reads_pause_reads_with_a_growing_back_off() {
        let mut gate = AxGate::default();
        let start = Instant::now();
        assert!(!gate.failed("no answer", start));
        assert!(!gate.failed("no answer", start));
        assert!(gate.closed(start).is_none());
        assert!(gate.failed("no answer", start), "the third closes it");
        assert!(gate.closed(start).unwrap().contains("unanswered"));
        assert!(
            gate.closed(start + Duration::from_millis(1100)).is_none(),
            "1 s"
        );
        assert!(gate.failed("no answer", start + Duration::from_secs(2)));
        assert!(
            gate.closed(start + Duration::from_millis(3500)).is_some(),
            "then 2 s"
        );
        assert!(gate.unavailable());
        gate.succeeded();
        assert!(!gate.unavailable() && gate.closed(start).is_none());
        for _ in 0..20 {
            gate.failed("x", start);
        }
        assert!(
            gate.closed(start + MAX_PAUSE + Duration::from_millis(1))
                .is_none(),
            "capped"
        );
    }

    #[test]
    fn reads_go_one_at_a_time_and_none_while_paused() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(tokio::task::LocalSet::new().run_until(async {
                let gate = AxGateCell::default();
                let busy = Rc::new(std::cell::Cell::new(0));
                let most = Rc::new(std::cell::Cell::new(0));
                let read = || {
                    let (busy, most) = (busy.clone(), most.clone());
                    async move {
                        busy.set(busy.get() + 1);
                        most.set(most.get().max(busy.get()));
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        busy.set(busy.get() - 1);
                        Err::<(), _>("did not arrive".into())
                    }
                };
                let closes = Rc::new(std::cell::Cell::new(0));
                let close = || closes.set(closes.get() + 1);
                let (a, b, c) = tokio::join!(
                    through(&gate, read(), close),
                    through(&gate, read(), close),
                    through(&gate, read(), close)
                );
                assert!(a.is_err() && b.is_err() && c.is_err());
                assert_eq!(most.get(), 1, "one at a time");
                assert_eq!(closes.get(), 1);
                let started = Instant::now();
                let refused = through(&gate, read(), close).await.unwrap_err();
                assert!(refused.to_string().contains("next try"));
                assert!(
                    started.elapsed() < Duration::from_millis(5),
                    "refused at once"
                );
            }));
    }
}
