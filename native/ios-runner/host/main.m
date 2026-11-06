// PokiRunnerHost: a small library loaded into Poki Runner (Xcode's XCTRunner host) before its own code.
// Started by Poki (through testmanagerd, with the XCTest session in the environment) it does nothing
// and XCTRunner runs as always. Opened by hand from the home screen, XCTRunner's app delegate is
// emptied, so it starts no test: no UI Automation, no passcode prompt. The runner then shows its own
// screen (RunnerInfo, from branding/) and sends the person to Poki.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static BOOL PokiStartedByTestManager(void) {
  NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
  // Any of these (some may be empty) means testmanagerd launched the runner for a test session.
  return env[@"XCTestSessionIdentifier"] != nil || env[@"XCTestConfigurationFilePath"] != nil ||
         env[@"XCTestBundlePath"] != nil || env[@"XCTestManagerVariant"] != nil;
}

static BOOL PokiYes(id self, SEL _cmd, ...) { return YES; }
static id PokiNothing(id self, SEL _cmd, ...) { return nil; }

/// Opened by hand: go straight to Poki, once per launch; Poki starts the runner itself.
static void PokiOpenPoki(id self, SEL _cmd, UIScene *scene) {
  static BOOL sent = NO;
  if (sent) { return; }
  sent = YES;
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:@"poki://"] options:@{} completionHandler:nil];
}

/// Runs when the library loads, before XCTRunner's main. (Running a whole app from here instead would
/// hold dyld's lock and hang.)
__attribute__((constructor)) static void PokiRunnerHostTakeOver(void) {
  if (PokiStartedByTestManager()) { return; }
  Class delegate = objc_getClass("_XCTRunnerAppDelegate") ?: objc_getClass("XCTRunnerAppDelegate");
  if (!delegate) { NSLog(@"PokiRunnerHost: no XCTRunner app delegate"); return; }
  // Kept: the window property (the scene's storyboard window lives in it) and the destructor.
  NSSet<NSString *> *keep = [NSSet setWithArray:@[@"window", @"setWindow:", @".cxx_destruct"]];
  unsigned int count = 0, emptied = 0;
  Method *methods = class_copyMethodList(delegate, &count);
  for (unsigned int i = 0; i < count; i++) {
    SEL name = method_getName(methods[i]);
    const char *types = method_getTypeEncoding(methods[i]);
    if ([keep containsObject:NSStringFromSelector(name)] || !strchr("v@cBqQi", types[0])) { continue; }
    BOOL yes = sel_isEqual(name, @selector(application:didFinishLaunchingWithOptions:)) || sel_isEqual(name, @selector(application:willFinishLaunchingWithOptions:));
    method_setImplementation(methods[i], yes ? (IMP)PokiYes : (IMP)PokiNothing);
    emptied++;
  }
  free(methods);
  class_replaceMethod(delegate, @selector(sceneDidBecomeActive:), (IMP)PokiOpenPoki, "v@:@");
  NSLog(@"PokiRunnerHost: opened by hand; %u of %u XCTRunner delegate methods emptied", emptied, count);
}
