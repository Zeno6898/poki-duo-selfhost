# Physical iPhone setup

Physical iPhone support has been verified only with the Chinese interface in portrait orientation. Read the [verification record and known limits](verification.md) first.

Run `./bin/setup` first. It needs full Xcode and the Rust toolchain, and you do not need to set any environment variables. See the [requirements](install.md#requirements).

## First-Time USB Preparation

1. Connect the iPhone to your Mac over USB, unlock the phone, and accept **Trust This Computer**.
2. On the iPhone, enable **Developer Mode** and turn on **UI Automation** in Developer Settings. Complete all on-device prompts manually.
3. Install the developer disk image (DDI) before capturing screens or injecting input:

```sh
node bin/prepare-device.mjs YOUR_DEVICE_ID
```

*(If exactly one device is connected, `YOUR_DEVICE_ID` can be omitted.)* The helper first asks the phone whether it already offers `displayservice`, and stops if it does. Otherwise it finds a DDI, has Apple's signing server personalize it for this phone, installs it through `cryptexd`, and checks `displayservice` again on a new connection. It does not alter security settings or reboot the device.

The DDI comes from the first of these that applies:

| Source | When |
| --- | --- |
| `POKI_DDI_DIR` | Set to an unpacked Cryptex1 DDI `Restore` directory, such as a copy of Xcode's. Used as given, never downloaded. |
| Xcode's `/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore` | On macOS, when it exists. |
| A downloaded copy | Otherwise, including on Linux. The helper downloads Apple's DDI once from the [doronz88/DeveloperDiskImage](https://github.com/doronz88/DeveloperDiskImage) mirror (`PersonalizedImages/Xcode_iOS_DDI_Cryptex`, about 16 MB, the files pymobiledevice3 uses) into `ddi/Xcode_iOS_DDI_Cryptex` under the state directory (`POKI_MCP_STATE_DIR`), and reuses it later. |

Every payload is checked against the SHA-384 digest in the DDI's `BuildManifest.plist` before anything is sent to the phone, and a damaged downloaded copy is fetched again. The phone also verifies Apple's signature. Personalization needs the host to reach Apple's signing server (`gs.apple.com`) over HTTP.

The Cryptex1 image is used because phones of the iPhone 18 series have no build identity for the older image mounter route in Apple's DDI. It works on any phone with iOS 17.4 or later.

To prepare a phone reached over the network with `POKI_DEVICE_HOST` and `POKI_RP_PAIRING_FILE` (see [configuration](configuration.md)), run the same command without a device ID. The `build/poki-native` bridge then does the status check and the install inside the remote pairing tunnel (`ddi_status` and `install_ddi` in [NATIVE.md](../native/NATIVE.md)), because `idevice-tools` cannot reach such a phone. A USB or usbmuxd device still uses `idevice-tools cryptexd install-ddi`.

The DDI stays installed until the phone restarts. Run the helper again after a restart.

## Before a test session

In **Settings > Display & Brightness > Auto-Lock**, choose a longer interval or **Never** for the test session. Turn off **Sleep Focus** and keep the iPhone unlocked with the target app visible. Restore your preferred settings after testing.

When the iPhone locks or sleeps, accessibility and input can fail or time out. Waking the screen does not unlock the phone. Unlock it manually, return to the target app, and read the screen again before retrying. Repeated retries while the phone is locked can spend time reconnecting to device services without completing the action.

After updating Poki or rebuilding the native helper, stop the running service and restart it with `npm start`. An existing service keeps its loaded JavaScript until it restarts. If it reports that it is running old code, restart it before retrying the phone task.

## Post-Pairing Wi-Fi Operation

Once paired over USB, the Mac and iPhone can communicate over the same local network for wireless discovery and supported operations while the phone stays unlocked and reachable:

- **Verified wireless operations**: Prior hardware testing (with USB disconnected) verified screenshots, accessibility field readback, standard key input, backward/forward deletion, Unicode paste, and verified paste followed by `Return`. *(Note: Those checks were not re-run as a full hardware pass after later input changes.)*
- **Native app launch**: Physical `launch_app` and `open_settings` without a page use the paired device’s RemoteXPC AppService directly. An explicit bundle ID skips application discovery; name lookup uses the advertised streaming app list. Arguments, environment, language, and locale are preserved. A positive process ID must match the observed foreground before success is reported. Foreground verification makes at most three observation attempts with a 2.5-second attempt limit and an 8-second total observation deadline; child-process cleanup completes before returning. Only observation is retried, never launch. If launch may have happened but cannot be confirmed, the receipt preserves known facts and stops even a permissive batch.
- **Application discovery**: Physical `list_apps` uses the paired device’s advertised streaming app list, including for shared name resolution. System filtering retains the application-path distinction. Container-access eligibility is not supplied by this list and is not inferred.
- **Wireless limitations**: Application install/uninstall use paired InstallationProxy and verify the resulting app inventory. If an installation is interrupted, its private recovery record remains under the state directory at `install/operations/<UUID>.json`, identifying the exact possible device staging path; it is never automatically retried or deleted while its status is uncertain. Remaining process/container management and Settings deep links still use Apple `devicectl`, which may fail to discover a wirelessly paired device (`CoreDeviceError 1000`) or reject a launch (`4016`). Native input and app launch do not prove those separate management paths work.
