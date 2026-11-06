import Foundation

/// The step did not finish in time. Whatever it was doing is abandoned and its late answer dropped.
public struct DeadlineExceeded: Error, CustomStringConvertible {
    public let what: String
    public let seconds: Double
    public var description: String { "\(what) did not finish within \(Self.format(seconds))" }
    static func format(_ seconds: Double) -> String { seconds < 10 ? String(format: "%.1f s", seconds) : "\(Int(seconds.rounded())) s" }
}

/// Resumes a continuation once; later results are dropped.
final class ResumeOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    init(_ continuation: CheckedContinuation<T, Error>) { self.continuation = continuation }
    @discardableResult func resume(_ result: Result<T, Error>) -> Bool {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        guard let pending else { return false }
        pending.resume(with: result)
        return true
    }
}

/// Runs `operation` and answers after at most `seconds`, whatever the operation does. The operation
/// runs in a task of its own and is cancelled at the deadline, but never waited for: an operation
/// that ignores cancellation cannot hold the caller (a task group would wait for it).
func withDeadline<T: Sendable>(_ seconds: Double, _ what: String, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    let holder = LockedBox<(ResumeOnce<T>, Task<Void, Never>)?>(nil)
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            let once = ResumeOnce(continuation)
            let work = Task {
                do { once.resume(.success(try await operation())) } catch { once.resume(.failure(error)) }
            }
            holder.value = (once, work)
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1e9))
                if once.resume(.failure(DeadlineExceeded(what: what, seconds: seconds))) { work.cancel() }
            }
        }
    } onCancel: {
        if let (once, work) = holder.value, once.resume(.failure(CancellationError())) { work.cancel() }
    }
}

final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ value: T) { stored = value }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
    func update<R>(_ body: (inout T) -> R) -> R { lock.lock(); defer { lock.unlock() }; return body(&stored) }
}

func sleep(seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1e9))
}

/// Monotonic seconds.
func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
