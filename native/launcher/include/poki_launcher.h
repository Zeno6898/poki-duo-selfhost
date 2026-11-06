// PokiLauncher: gets the WebDriverAgent runner up on this phone and keeps it up; pairs the phone with
// itself (iOS 27). docs/ios-core.md §3. Every string passed in is UTF-8 and only read during the call;
// event strings are valid only during the callback, which runs on a launcher thread.
#ifndef POKI_LAUNCHER_H
#define POKI_LAUNCHER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PokiLauncher PokiLauncher;
typedef struct PokiPairing PokiPairing;
typedef void (*poki_event_cb)(void *context, const char *event_json);

// config_json: {"device_address": "10.7.0.1", "pairing_file": "...", "host_name": "Poki",
//   "ddi_dir": "...", "runner_bundle": null, "wda_host": "127.0.0.1", "wda_port": 8100}
// Events: {"state": "idle|connecting|pairing|mounting_ddi|launching|running|waiting_network|failed",
//   "attempt": n, "since_ms": n, "pairing": "remote|lockdown", "ios": "...", "runner": "...",
//   "detail": "...", "fix": "..."}
PokiLauncher *poki_launcher_new(const char *config_json, poki_event_cb cb, void *context);
int32_t poki_launcher_start(PokiLauncher *launcher);
void poki_launcher_restart(PokiLauncher *launcher);
void poki_launcher_stop(PokiLauncher *launcher);
char *poki_launcher_status(PokiLauncher *launcher);
void poki_launcher_free(PokiLauncher *launcher);
void poki_string_free(char *text);

// config_json: {"host_name": "Poki", "out_path": "...", "identity_path": "..."}
// Events: {"event": "advertise", "service_type": "_remotepairing-pairable-host._tcp", "instance": "...",
//   "port": n, "txt": {...}} (publish it with Bonjour), {"event": "pin", "pin": "123456"},
//   {"event": "paired", "path": "..."}, {"event": "failed", "detail": "..."}
PokiPairing *poki_pair_start(const char *config_json, poki_event_cb cb, void *context);
void poki_pair_cancel(PokiPairing *pairing);

#ifdef __cplusplus
}
#endif

#endif
