// PokiRunnerHost: a small library loaded into Poki Runner (Xcode's XCTRunner host) before its own code.
// Started by Poki (through testmanagerd, with the XCTest session in the environment) it does nothing
// and XCTRunner runs as always. Opened by hand from the home screen, it takes over before XCTRunner's
// main: no test, no UI Automation, no passcode prompt; one screen that sends the person to Poki.
#import <UIKit/UIKit.h>

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

@interface PokiRunnerSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation PokiRunnerSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [PokiRunnerInfo new];
  [self.window makeKeyAndVisible];
}
- (void)sceneDidBecomeActive:(UIScene *)scene {
  // Opened by hand: go straight to Poki (once per launch), which starts the runner itself.
  static BOOL sent = NO;
  if (sent) { return; }
  sent = YES;
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:@"poki://"] options:@{} completionHandler:nil];
}
@end

@interface PokiRunnerAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation PokiRunnerAppDelegate
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:@"Poki" sessionRole:session.role];
  config.delegateClass = PokiRunnerSceneDelegate.class;
  config.storyboard = nil;
  return config;
}
@end

/// Runs before XCTRunner's main (dyld runs a library's initializers first) and, opened by hand, never
/// returns to it.
__attribute__((constructor)) static void PokiRunnerHostTakeOver(int argc, char **argv, char **envp) {
  if (PokiStartedByTestManager()) { return; }
  @autoreleasepool {
    exit(UIApplicationMain(argc, argv, nil, NSStringFromClass(PokiRunnerAppDelegate.class)));
  }
}
