// PokiRunnerHost: a small library loaded into Poki Runner (Xcode's XCTRunner host) before its own code.
// Started by Poki (through testmanagerd, with the XCTest session in the environment) it does nothing
// and XCTRunner runs as always. Opened by hand from the home screen, XCTRunner's app delegate is
// emptied, so it starts no test: no UI Automation, no passcode prompt. It shows one screen that sends
// the person to Poki.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static BOOL PokiStartedByTestManager(void) {
  NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
  // Any of these (some may be empty) means testmanagerd launched the runner for a test session.
  return env[@"XCTestSessionIdentifier"] != nil || env[@"XCTestConfigurationFilePath"] != nil ||
         env[@"XCTestBundlePath"] != nil || env[@"XCTestManagerVariant"] != nil;
}

static UIColor *PokiBlue(void) { return [UIColor colorWithRed:0x20/255.0 green:0x84/255.0 blue:0xFD/255.0 alpha:1]; }

@interface PokiRunnerInfo : UIViewController
@end

@implementation PokiRunnerInfo
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = PokiBlue();
  UIImageView *bear = [[UIImageView alloc] initWithImage:[UIImage imageNamed:@"LaunchBear"]];
  bear.contentMode = UIViewContentModeScaleAspectFit;
  UILabel *title = [UILabel new];
  title.text = @"Poki Runner";
  title.font = [UIFont systemFontOfSize:30 weight:UIFontWeightBold];
  UILabel *body = [UILabel new];
  body.text = @"Poki starts this app when an agent needs your iPhone. There is nothing to do here.";
  body.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  body.adjustsFontForContentSizeCategory = YES;
  for (UILabel *label in @[title, body]) {
    label.textColor = UIColor.whiteColor;
    label.numberOfLines = 0;
    label.textAlignment = NSTextAlignmentCenter;
  }
  UIButtonConfiguration *style = UIButtonConfiguration.filledButtonConfiguration;
  style.baseBackgroundColor = UIColor.whiteColor;
  style.baseForegroundColor = PokiBlue();
  style.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  style.buttonSize = UIButtonConfigurationSizeLarge;
  UIButton *open = [UIButton buttonWithConfiguration:style primaryAction:[UIAction actionWithTitle:@"Open Poki" image:nil identifier:nil handler:^(__kindof UIAction *action) {
    [UIApplication.sharedApplication openURL:[NSURL URLWithString:@"poki://"] options:@{} completionHandler:nil];
  }]];
  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[bear, title, body, open]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.alignment = UIStackViewAlignmentCenter;
  stack.spacing = 16;
  [stack setCustomSpacing:28 afterView:body];
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  UILayoutGuide *margins = self.view.readableContentGuide;
  [NSLayoutConstraint activateConstraints:@[
    [bear.widthAnchor constraintEqualToConstant:150],
    [bear.heightAnchor constraintEqualToConstant:150],
    [stack.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:margins.leadingAnchor constant:16],
    [stack.trailingAnchor constraintEqualToAnchor:margins.trailingAnchor constant:-16],
  ]];
}
@end

static BOOL PokiYes(id self, SEL _cmd, ...) { return YES; }

/// Opened by hand, each scene gets Poki Runner's own screen, kept in XCTRunner's window property.
static void PokiSceneWillConnect(id self, SEL _cmd, UIScene *scene, UISceneSession *session, UISceneConnectionOptions *options) {
  if (![scene isKindOfClass:UIWindowScene.class]) { return; }
  UIWindow *window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  window.rootViewController = [PokiRunnerInfo new];
  if ([self respondsToSelector:@selector(setWindow:)]) { [self performSelector:@selector(setWindow:) withObject:window]; }
  objc_setAssociatedObject(self, @selector(setWindow:), window, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [window makeKeyAndVisible];
  NSLog(@"PokiRunnerHost: showing Poki Runner's screen");
}
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
  class_replaceMethod(delegate, @selector(scene:willConnectToSession:options:), (IMP)PokiSceneWillConnect, "v@:@@@");
  class_replaceMethod(delegate, @selector(sceneDidBecomeActive:), (IMP)PokiOpenPoki, "v@:@");
  NSLog(@"PokiRunnerHost: opened by hand; %u of %u XCTRunner delegate methods emptied", emptied, count);
}
