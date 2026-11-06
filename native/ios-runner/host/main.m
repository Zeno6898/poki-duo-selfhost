// PokiRunnerHost: a small library loaded into Poki Runner (Xcode's XCTRunner host) before its own code.
//
// Started by Poki (through testmanagerd, with the XCTest session in the environment), XCTRunner runs
// as always, and this library draws Poki Runner's in-use screen over XCTRunner's black window as soon
// as the scene is up: the person sees what is going on and that the runner must stay open. The WDA
// test calls PokiRunnerShowInUse too, once it serves.
//
// Opened by hand from the home screen, XCTRunner's app delegate is emptied, so it starts no test: no
// UI Automation, no passcode prompt. It shows a short screen and then opens Poki.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static BOOL PokiStartedByTestManager(void) {
  NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
  // Any of these (some may be empty) means testmanagerd launched the runner for a test session.
  return env[@"XCTestSessionIdentifier"] != nil || env[@"XCTestConfigurationFilePath"] != nil ||
         env[@"XCTestBundlePath"] != nil || env[@"XCTestManagerVariant"] != nil;
}

static UIColor *PokiBlue(void) { return [UIColor colorWithRed:0x20/255.0 green:0x84/255.0 blue:0xFD/255.0 alpha:1]; }
static UIColor *PokiIndigo(void) { return [UIColor colorWithRed:0.29 green:0.33 blue:0.96 alpha:1]; }

static void PokiOpenPokiNow(void) {
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:@"poki://"] options:@{} completionHandler:nil];
}

static UIFont *PokiRounded(CGFloat size, UIFontWeight weight) {
  UIFont *font = [UIFont systemFontOfSize:size weight:weight];
  UIFontDescriptor *rounded = [font.fontDescriptor fontDescriptorWithDesign:UIFontDescriptorSystemDesignRounded];
  return rounded ? [UIFont fontWithDescriptor:rounded size:size] : font;
}

static UILabel *PokiLabel(NSString *text, UIFont *font, CGFloat alpha, NSTextAlignment alignment) {
  UILabel *label = [UILabel new];
  NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
  paragraph.lineSpacing = 3;
  paragraph.alignment = alignment;
  label.attributedText = [[NSAttributedString alloc] initWithString:text attributes:@{
    NSFontAttributeName: font,
    NSForegroundColorAttributeName: [UIColor colorWithWhite:1 alpha:alpha],
    NSParagraphStyleAttributeName: paragraph,
  }];
  label.numberOfLines = 0;
  return label;
}

/// One line with an icon, for the in-use screen's card.
static UIView *PokiTip(NSString *symbol, NSString *text) {
  UIImageView *icon = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:symbol withConfiguration:[UIImageSymbolConfiguration configurationWithPointSize:17 weight:UIImageSymbolWeightSemibold]]];
  icon.tintColor = UIColor.whiteColor;
  icon.contentMode = UIViewContentModeCenter;
  UILabel *label = PokiLabel(text, [UIFont preferredFontForTextStyle:UIFontTextStyleSubheadline], 0.95, NSTextAlignmentLeft);
  UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[icon, label]];
  row.axis = UILayoutConstraintAxisHorizontal;
  row.alignment = UIStackViewAlignmentTop;
  row.spacing = 12;
  [NSLayoutConstraint activateConstraints:@[[icon.widthAnchor constraintEqualToConstant:26], [icon.heightAnchor constraintEqualToConstant:22]]];
  return row;
}

@interface PokiRunnerScreen : UIViewController
@property (nonatomic) BOOL inUse;
@end

@implementation PokiRunnerScreen {
  CAGradientLayer *_gradient;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  _gradient = [CAGradientLayer layer];
  _gradient.colors = @[(id)PokiBlue().CGColor, (id)PokiIndigo().CGColor];
  _gradient.startPoint = CGPointMake(0.2, 0);
  _gradient.endPoint = CGPointMake(0.8, 1);
  [self.view.layer insertSublayer:_gradient atIndex:0];
  self.view.backgroundColor = PokiBlue();
  self.view.accessibilityIdentifier = @"PokiRunnerScreen";

  UIImageView *bear = [[UIImageView alloc] initWithImage:[UIImage imageNamed:@"LaunchBear"]];
  bear.contentMode = UIViewContentModeScaleAspectFit;
  bear.layer.shadowColor = UIColor.blackColor.CGColor;
  bear.layer.shadowOpacity = 0.25;
  bear.layer.shadowRadius = 18;
  bear.layer.shadowOffset = CGSizeMake(0, 10);

  NSMutableArray<UIView *> *views = [NSMutableArray arrayWithObject:bear];
  UILabel *title = PokiLabel(self.inUse ? @"Poki is using\nthis iPhone" : @"Poki Runner", PokiRounded(30, UIFontWeightBold), 1, NSTextAlignmentCenter);
  [views addObject:title];
  UILabel *body = PokiLabel(self.inUse ? @"An agent is working on this iPhone through Poki. Poki Runner can stay in the background."
                                       : @"Poki starts this helper when an agent needs your iPhone. There's nothing to do here.",
                            [UIFont preferredFontForTextStyle:UIFontTextStyleBody], 0.88, NSTextAlignmentCenter);
  [views addObject:body];

  UIView *card = nil;
  if (self.inUse) {
    UIStackView *tips = [[UIStackView alloc] initWithArrangedSubviews:@[
      PokiTip(@"rectangle.stack.badge.minus", @"Don't close Poki Runner while the agent works. Closing it stops the agent."),
      PokiTip(@"stop.circle", @"To stop, tap Stop in Poki or on the Live Activity."),
      PokiTip(@"moon.zzz", @"When the agent goes quiet, Poki puts the runner to sleep by itself."),
    ]];
    tips.axis = UILayoutConstraintAxisVertical;
    tips.spacing = 14;
    tips.translatesAutoresizingMaskIntoConstraints = NO;
    card = [UIView new];
    card.backgroundColor = [UIColor colorWithWhite:1 alpha:0.14];
    card.layer.cornerRadius = 22;
    card.layer.cornerCurve = kCACornerCurveContinuous;
    [card addSubview:tips];
    [NSLayoutConstraint activateConstraints:@[
      [tips.topAnchor constraintEqualToAnchor:card.topAnchor constant:18],
      [tips.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-18],
      [tips.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:18],
      [tips.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-18],
    ]];
    [views addObject:card];
  }

  UIButtonConfiguration *style = UIButtonConfiguration.filledButtonConfiguration;
  style.baseBackgroundColor = UIColor.whiteColor;
  style.baseForegroundColor = PokiBlue();
  style.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  style.buttonSize = UIButtonConfigurationSizeLarge;
  style.contentInsets = NSDirectionalEdgeInsetsMake(14, 28, 14, 28);
  style.titleTextAttributesTransformer = ^NSDictionary<NSAttributedStringKey, id> *(NSDictionary<NSAttributedStringKey, id> *attributes) {
    NSMutableDictionary *out = [attributes mutableCopy];
    out[NSFontAttributeName] = PokiRounded(17, UIFontWeightSemibold);
    return out;
  };
  UIButton *open = [UIButton buttonWithConfiguration:style primaryAction:[UIAction actionWithTitle:@"Open Poki" image:nil identifier:nil handler:^(__kindof UIAction *action) {
    PokiOpenPokiNow();
  }]];
  [views addObject:open];

  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:views];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.alignment = UIStackViewAlignmentCenter;
  stack.spacing = 12;
  [stack setCustomSpacing:24 afterView:bear];
  [stack setCustomSpacing:self.inUse ? 24 : 32 afterView:body];
  if (card) { [stack setCustomSpacing:28 afterView:card]; }
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  NSMutableArray<NSLayoutConstraint *> *constraints = [NSMutableArray arrayWithArray:@[
    [bear.widthAnchor constraintEqualToConstant:self.inUse ? 112 : 132],
    [bear.heightAnchor constraintEqualToConstant:self.inUse ? 112 : 132],
    [stack.centerYAnchor constraintEqualToAnchor:guide.centerYAnchor],
    [stack.centerXAnchor constraintEqualToAnchor:guide.centerXAnchor],
    [stack.widthAnchor constraintLessThanOrEqualToConstant:360],
    [stack.leadingAnchor constraintGreaterThanOrEqualToAnchor:guide.leadingAnchor constant:28],
    [stack.trailingAnchor constraintLessThanOrEqualToAnchor:guide.trailingAnchor constant:-28],
    [body.widthAnchor constraintEqualToAnchor:stack.widthAnchor],
    [title.widthAnchor constraintEqualToAnchor:stack.widthAnchor],
  ]];
  NSLayoutConstraint *wide = [stack.widthAnchor constraintEqualToConstant:360];
  wide.priority = UILayoutPriorityDefaultHigh;
  [constraints addObject:wide];
  if (card) { [constraints addObject:[card.widthAnchor constraintEqualToAnchor:stack.widthAnchor]]; }
  [NSLayoutConstraint activateConstraints:constraints];
}

- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  _gradient.frame = self.view.bounds;
}

- (UIStatusBarStyle)preferredStatusBarStyle { return UIStatusBarStyleLightContent; }
@end

// MARK: In use (started by Poki)

static UIWindow *PokiInUseWindow;

/// Shows the in-use screen over XCTRunner's window on the first window scene. Safe to call more than
/// once and from the WDA test.
__attribute__((visibility("default"))) void PokiRunnerShowInUse(void) {
  if (!NSThread.isMainThread) { dispatch_async(dispatch_get_main_queue(), ^{ PokiRunnerShowInUse(); }); return; }
  if (PokiInUseWindow.windowScene) { return; }
  UIWindowScene *scene = nil;
  for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes) {
    if ([candidate isKindOfClass:UIWindowScene.class]) { scene = (UIWindowScene *)candidate; break; }
  }
  if (!scene) { return; }
  PokiRunnerScreen *screen = [PokiRunnerScreen new];
  screen.inUse = YES;
  PokiInUseWindow = [[UIWindow alloc] initWithWindowScene:scene];
  PokiInUseWindow.windowLevel = UIWindowLevelAlert + 1;
  PokiInUseWindow.rootViewController = screen;
  PokiInUseWindow.hidden = NO;
  NSLog(@"PokiRunnerHost: showing the in-use screen");
}

// MARK: Opened by hand

static BOOL PokiYes(id self, SEL _cmd, ...) { return YES; }
static id PokiNothing(id self, SEL _cmd, ...) { return nil; }

/// Opened by hand, each scene gets Poki Runner's own screen, kept in XCTRunner's window property.
static void PokiSceneWillConnect(id self, SEL _cmd, UIScene *scene, UISceneSession *session, UISceneConnectionOptions *options) {
  if (![scene isKindOfClass:UIWindowScene.class]) { return; }
  UIWindow *window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  window.rootViewController = [PokiRunnerScreen new];
  if ([self respondsToSelector:@selector(setWindow:)]) { [self performSelector:@selector(setWindow:) withObject:window]; }
  objc_setAssociatedObject(self, @selector(setWindow:), window, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [window makeKeyAndVisible];
  NSLog(@"PokiRunnerHost: showing Poki Runner's screen");
}

/// Opened by hand: after a moment on the screen (so it is never a blank flash), open Poki, which starts
/// the runner itself when an agent needs it. Each time the runner comes to the front.
static void PokiOpenPoki(id self, SEL _cmd, UIScene *scene) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive) { PokiOpenPokiNow(); }
  });
}

/// Runs when the library loads, before XCTRunner's main. (Running a whole app from here instead would
/// hold dyld's lock and hang.)
__attribute__((constructor)) static void PokiRunnerHostTakeOver(void) {
  if (PokiStartedByTestManager()) {
    // Cover XCTRunner's black window as soon as there is a scene; the WDA test calls this again.
    [NSNotificationCenter.defaultCenter addObserverForName:UISceneDidActivateNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      PokiRunnerShowInUse();
    }];
    return;
  }
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
