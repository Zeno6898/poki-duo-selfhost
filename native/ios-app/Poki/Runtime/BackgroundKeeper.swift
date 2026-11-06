import CoreLocation
import Foundation

/// Keeps Poki running in the background while it is on, so the relay connection and the launcher stay
/// up: location updates at the coarsest accuracy with a background activity session (iOS shows the
/// location pill), plus the silent-audio fallback. The location is never read or sent anywhere.
@MainActor
@Observable
final class BackgroundKeeper: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var activity: CLBackgroundActivitySession?
    private let audio = KeepAlive()
    private(set) var authorization: CLAuthorizationStatus
    private(set) var isOn = false

    override init() {
        authorization = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        manager.distanceFilter = CLLocationDistanceMax
        manager.pausesLocationUpdatesAutomatically = false
    }

    var allowed: Bool { authorization == .authorizedWhenInUse || authorization == .authorizedAlways }
    var denied: Bool { authorization == .denied || authorization == .restricted }

    func requestPermission() { manager.requestWhenInUseAuthorization() }

    /// Called while Poki is in front (iOS only starts background location from the foreground).
    func start() {
        guard !isOn else { return }
        isOn = true
        if allowed { startLocation() } else if authorization == .notDetermined { requestPermission() }
        try? audio.start()
    }

    func stop() {
        guard isOn else { return }
        isOn = false
        manager.stopUpdatingLocation()
        activity?.invalidate(); activity = nil
        audio.stop()
    }

    private func startLocation() {
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        if activity == nil { activity = CLBackgroundActivitySession() }
        manager.startUpdatingLocation()
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            if self.isOn, self.allowed { self.startLocation() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {}
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
