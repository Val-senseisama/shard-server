export default `#graphql
  scalar JSON

  type Query {
    hello: String
    
    # User queries
   currentUser: UserResponse!
    checkUsername(username: String!): UsernameCheckResponse!
    getSignedUploadUrl: UploadUrlResponse!
    searchUsers(query: String!, type: String): UserSearchResponse!
    
    # Shard queries
    myShards: ShardsResponse!
    getShard(id: ID!): ShardResponse!
    getShardSchedule(shardId: ID!, startDate: String, endDate: String): ScheduleResponse!
    getMySchedule(startDate: String, endDate: String): MyScheduleResponse!
    getShardAnalytics(shardId: ID!): ShardAnalyticsResponse!
    
    # Friendship queries
    getFriends: FriendsResponse!
    getPendingRequests: PendingRequestsResponse!
    getFriendSuggestions: SuggestionsResponse!
    getFriendshipStatus(friendId: ID!): FriendshipStatusResponse!
    
    # Chat queries
    myChats: ChatsResponse!
    getChatMessages(chatId: ID!, limit: Int, skip: Int): ChatMessagesResponse!
    getUnreadCount: UnreadCountResponse!
    getChat(chatId: ID!): GetChatResponse!
    
    # XP & Progression queries
    getXP: XPResponse!
    getStreaks: StreaksResponse!
    getAchievements: AchievementsResponse!
    
    # Challenge queries
    myChallenges: ChallengesResponse!
    getActiveChallengesCount: CountResponse!
    
    # Side Quest queries
    mySideQuests: SideQuestsResponse!
    canGenerateSideQuest: GenerateCheckResponse!
    
    # Analytics queries
    getProductivityData: ProductivityResponse!
    getMyStats: StatsResponse!
    
    # Notification queries
    getNotifications(limit: Int, skip: Int, shardId: ID): NotificationsResponse!
    getUnreadNotificationCount: UnreadNotificationCountResponse!
    getNotificationPreferences: NotificationPreferencesResponse!
    
    # Report queries
    myReports: ReportsResponse!
    getPendingReports: PendingReportsResponse!
    
    # Support queries
    mySupportFlags: SupportFlagsResponse!
    getAllSupportFlags: AllSupportFlagsResponse!
  }

  type Mutation {
    # User mutations
    signup(input: SignupInput!): AuthResponse!
    login(email: String!, password: String!): AuthResponse!
    requestLoginCode(email: String!): MessageResponse!
    verifyLoginCode(email: String!, code: String!): AuthResponse!
    googleSignIn(idToken: String!): AuthResponse!
    logout: MessageResponse!
    updateProfile(input: UpdateProfileInput!): ProfileResponse!
    changePassword(currentPassword: String!, newPassword: String!): MessageResponse!
    updateProfilePicture(cloudinaryUrl: String!): ProfilePictureResponse!
    updatePreferences(input: PreferencesInput!): MessageResponse!
    
    # Shard mutations
    createShard(goal: String!, deadline: String, image: String, participants: [ParticipantInput!], isPrivate: Boolean, isAnonymous: Boolean): CreateShardResponse!
    createShardManual(input: CreateShardInput!): CreateShardResponse!
    updateShard(id: ID!, input: UpdateShardInput!): ShardResponse!
    deleteShard(id: ID!): MessageResponse!
    addShardParticipant(shardId: ID!, userId: ID!, role: String!): AddParticipantResponse!
    removeShardParticipant(shardId: ID!, userId: ID!): MessageResponse!
    assignMiniGoal(miniGoalId: ID!, userId: ID!): MessageResponse!
    completeMiniGoal(miniGoalId: ID!): CompleteMiniGoalResponse!
    scheduleTasks(shardId: ID!): GenerateTasksResponse!
    generateWeeklyTasks(miniGoalId: ID!, weekNumber: Int, action: String): GenerateTasksResponse!
    deleteTask(miniGoalId: ID!, taskTitle: String!): MessageResponse!
    restoreTask(miniGoalId: ID!, taskTitle: String!): MessageResponse!
    
    # Friendship mutations
    sendFriendRequest(friendId: ID!): MessageResponse!
    acceptFriendRequest(friendId: ID!): MessageResponse!
    rejectFriendRequest(friendId: ID!): MessageResponse!
    cancelFriendRequest(friendId: ID!): MessageResponse!
    unfriend(friendId: ID!): MessageResponse!
    blockUser(userId: ID!): MessageResponse!
    
    # Chat mutations
    createOrGetDirectChat(friendId: ID!): ChatResponse!
    createOrGetShardChat(shardId: ID!): ChatResponse!
    sendMessage(chatId: ID!, content: String!, type: String, replyTo: ID, attachments: [AttachmentInput!]): SendMessageResponse!
    markMessagesRead(chatId: ID!, messageIds: [ID!]!): MessageResponse!
    editMessage(messageId: ID!, content: String!): MessageResponse!
    deleteMessage(messageId: ID!): MessageResponse!
    addReaction(messageId: ID!, emoji: String!): MessageResponse!
    removeReaction(messageId: ID!, emoji: String!): MessageResponse!
    
    # XP mutations
    completeTask(shardId: ID!, miniGoalId: ID!, taskIndex: Int!): CompleteTaskResponse!
    clearPendingAchievements: MessageResponse!
    
    # Challenge mutations
    createChallenge(input: CreateChallengeInput!): ChallengeResponse!
    completeChallenge(challengeId: ID!): CompleteChallengeResponse!
    
    # Side Quest mutations
    generateSideQuest(category: String): SideQuestResponse!
    completeSideQuest(sideQuestId: ID!): CompleteSideQuestResponse!
    
    # Analytics mutations
    trackActivity(activity: ActivityInput!): MessageResponse!
    
    # Notification mutations
    markNotificationRead(notificationId: ID!): MessageResponse!
    markAllNotificationsRead: MessageResponse!
    updateNotificationPreferences(input: NotificationPreferencesInput!): NotificationPreferencesUpdateResponse!
    deleteNotification(notificationId: ID!): MessageResponse!
    
    # Push Notification mutations
    registerPushToken(token: String!, platform: String!, deviceId: String): MessageResponse!
    unregisterPushToken(token: String!): MessageResponse!
    sendTestNotification: MessageResponse!
    
    # Report mutations
    reportUser(reportedUserId: ID!, reason: String!, details: String, reportedItemId: ID, reportedItemType: String): MessageResponse!
    updateReportStatus(reportId: ID!, status: String!, resolution: String): MessageResponse!
    
    # Support mutations
    createSupportFlag(input: CreateSupportFlagInput!): SupportFlagResponse!
    updateSupportFlag(flagId: ID!, status: String, assignedTo: ID, resolution: String): SupportFlagResponse!
  }

  # Input types
  input SignupInput {
    email: String!
    username: String!
    password: String!
  }

  input UpdateProfileInput {
    username: String
    bio: String
    profilePic: String
  }

  input PreferencesInput {
    workloadLevel: String
    maxTasksPerDay: Int
    workingDays: [Int!]
    preferredTaskDuration: String
  }

  type UserPreferences {
    workloadLevel: String!
    maxTasksPerDay: Int!
    workingDays: [Int!]!
    preferredTaskDuration: String!
  }

  # Response types
  type User {
    id: ID!
    email: String
    username: String
    bio: String
    profilePic: String
    role: String
    emailVerified: Boolean
    xp: Int
    level: Int
    achievements: [String]
    strength: Int
    intelligence: Int
    charisma: Int
    endurance: Int
    creativity: Int
    authProvider: String
    isNewUser: Boolean
    currentStreak: Int
    longestStreak: Int
    preferences: UserPreferences
    subscriptionTier: String
  }

  type UserResponse {
    success: Boolean!
    message: String!
    user: User
  }

  type AuthResponse {
    success: Boolean!
    message: String!
    accessToken: String
    refreshToken: String
    user: User
  }

  type MessageResponse {
    success: Boolean!
    message: String!
  }

  type ProfileResponse {
    success: Boolean!
    message: String!
    user: User
  }

  type UsernameCheckResponse {
    success: Boolean!
    available: Boolean!
  }

  type UploadUrlResponse {
    success: Boolean!
    message: String!
    uploadUrl: String
    params: SignedUploadParams
  }

  type SignedUploadParams {
    apiKey: String!
    timestamp: Int!
    publicId: String!
    signature: String!
    folder: String!
    cloudName: String!
  }

  type ProfilePictureResponse {
    success: Boolean!
    message: String!
    profilePic: String
  }

  type UserSearchResult {
    id: ID!
    username: String!
    profilePic: String
    mutualFriends: Int!
  }

  type UserSearchResponse {
    success: Boolean!
    users: [UserSearchResult!]!
  }

  # Shard types
  type Shard {
    image: String
    id: ID!
    title: String!
    description: String
    status: String!
    progress: ShardProgress!
    timeline: ShardTimeline!
    participants: [Participant!]!
    participantsCount: Int
    rewards: [Reward!]!
    owner: ShardOwner
    minigoals: [MiniGoal!]!
    chatId: ID
    isPrivate: Boolean
    isAnonymous: Boolean
    version: Int
  }

  type ShardProgress {
    completion: Int!
    xpEarned: Int!
    level: Int!
  }

  type ShardTimeline {
    startDate: String!
    endDate: String
  }

  type Participant {
    user: String!
    username: String
    profilePic: String
    role: String!
  }

  type Reward {
    type: String!
    value: JSON!
  }

  type ShardOwner {
    id: ID!
    username: String!
  }

  type MiniGoal {
    id: ID!
    shardId: ID!
    title: String!
    description: String
    progress: Int!
    completed: Boolean!
    tasks: [Task!]!
    version: Int
  }

  type Task {
    title: String!
    dueDate: String
    completed: Boolean!
  }

  input CreateShardInput {
    image: String
    title: String!
    description: String
    participants: [ParticipantInput!]
    timeline: TimelineInput!
    rewards: [RewardInput!]
    isPrivate: Boolean
    isAnonymous: Boolean
  }

  input ParticipantInput {
    user: ID!
    role: String!
  }

  input TimelineInput {
    startDate: String!
    endDate: String
  }

  input RewardInput {
    type: String!
    value: JSON!
  }

  input UpdateShardInput {
    image: String
    title: String
    description: String
    status: String
    timeline: TimelineInput
    participants: [ParticipantInput!]
    isPrivate: Boolean
    isAnonymous: Boolean
    version: Int
  }

  type CreateShardResponse {
    success: Boolean!
    message: String!
    shard: ShardSummary
    needsUpgrade: Boolean
    aiCallsRemaining: Int
  }

  type ShardSummary {
    id: ID!
    title: String!
    description: String
    image: String
    status: String!
    progress: ShardProgress!
    aiUsed: Boolean
    aiCallsRemaining: Int
  }

  type ShardResponse {
    success: Boolean!
    message: String!
    shard: Shard
  }

  type ShardsResponse {
    success: Boolean!
    shards: [ShardSummary!]!
  }

  type ScheduleResponse {
    success: Boolean!
    message: String
    tasksByDate: JSON
    tasks: [ScheduledTask!]
  }

  type MyScheduleResponse {
    success: Boolean!
    message: String
    tasksByDate: JSON
    tasks: [ScheduledTask!]
    todaysTasks: [ScheduledTask!]
  }

  type ScheduledTask {
    id: ID!
    title: String!
    dueDate: String
    completed: Boolean!
    xpReward: Int
    miniGoalId: ID
    miniGoalTitle: String
    shardId: ID
    shardTitle: String
  }

  type ShardAnalyticsResponse {
    success: Boolean!
    message: String
    weeklyCompletion: Int!
    dailyProgress: [DailyProgress!]!
    totalTasks: Int!
    completedTasks: Int!
  }

  type DailyProgress {
    date: String!
    tasksCompleted: Int!
    tasksTotal: Int!
  }

  # Friendship types
  type Friend {
    id: ID!
    username: String!
    profilePic: String
    email: String
    acceptedAt: String
    isOnline: Boolean
    lastActive: String
  }

  type FriendsResponse {
    success: Boolean!
    friends: [Friend!]!
  }

  type PendingRequestsResponse {
    success: Boolean!
    incoming: [Friend!]!
    outgoing: [Friend!]!
  }

  type FriendSuggestion {
    id: ID!
    username: String!
    profilePic: String
  }

  type SuggestionsResponse {
    success: Boolean!
    suggestions: [FriendSuggestion!]!
  }

  type FriendshipStatusResponse {
    success: Boolean!
    status: String!
    requestedBy: String
  }

  # Chat types
  type ChatParticipant {
    id: ID!
    username: String!
    profilePic: String
  }

  type ChatSummary {
    id: ID!
    type: String!
    participants: [ChatParticipant!]!
    createdAt: String!
    updatedAt: String!
  }

  type ChatsResponse {
    success: Boolean!
    chats: [ChatSummary!]!
  }

  type MessageData {
    id: ID!
    content: String!
    type: String!
    mediaUrl: String
    sender: ChatParticipant!
    replyTo: ID
    readBy: [ID!]!
    readAt: [ReadReceipt!]!
    edited: Boolean!
    editedAt: String
    deleted: Boolean!
    attachments: [Attachment!]!
    reactions: [ReactionData!]!
    createdAt: String!
  }

  type ReadReceipt {
    userId: ID!
    readAt: String!
  }

  type ChatMessagesResponse {
    success: Boolean!
    message: String
    messages: [MessageData!]!
  }

  type SendMessageResponse {
    success: Boolean!
    message: String!
    messageData: MessageData
  }

  type ChatResponse {
    success: Boolean!
    message: String
    chatId: ID
  }

  type GetChatResponse {
    success: Boolean!
    message: String
    chat: ChatDetail
  }

  type ChatDetail {
    id: ID!
    type: String!
    name: String
    participants: [ChatParticipant!]!
    shard: ShardDetail
    createdAt: String!
  }

  type ShardDetail {
    id: ID!
    title: String!
  }

  type UnreadCountResponse {
    success: Boolean!
    count: Int!
  }

  # Participant types
  type AddParticipantResponse {
    success: Boolean!
    message: String!
    addedUser: AddedParticipant
  }

  type AddedParticipant {
    id: ID!
    username: String!
    role: String!
  }

  # XP & Progression types
  type XPResult {
    newXP: Int!
    newLevel: Int!
    leveledUp: Boolean!
  }

  type XPResponse {
    success: Boolean!
    xp: Int!
    level: Int!
    xpNeeded: Int!
    achievements: [String!]!
    pendingAchievements: [String!]!
  }

  type AchievementDetail {
    id: String!
    name: String!
    description: String!
    icon: String!
    category: String!
    rarity: String!
    earned: Boolean!
    pending: Boolean!
  }

  type AchievementsResponse {
    success: Boolean!
    achievements: [AchievementDetail!]!
  }

  type StreakInfo {
    type: String!
    currentStreak: Int!
    longestStreak: Int!
    lastActivityDate: String!
  }

  type StreaksResponse {
    success: Boolean!
    streaks: [StreakInfo!]!
  }

  type CompleteTaskResponse {
    success: Boolean!
    message: String!
    xpEarned: Int!
    xpResult: XPResult
    achievements: [String!]!
  }

  # Challenge types
  input CreateChallengeInput {
    type: String!
    title: String!
    description: String
    targetDate: String!
    shardId: ID
    xpReward: Int
  }
  type ChallengeSummary {
    id: ID!
    type: String!
    title: String!
    description: String
    targetDate: String!
    xpReward: Int!
  }

  type ChallengesResponse {
    success: Boolean!
    challenges: [ChallengeSummary!]!
  }

  type ChallengeResponse {
    success: Boolean!
    message: String!
    challenge: ChallengeSummary
  }

  type CompleteChallengeResponse {
    success: Boolean!
    message: String!
    xpEarned: Int!
    xpResult: XPResult
  }

  type CountResponse {
    success: Boolean!
    count: Int!
  }

  # Side Quest types
  type SideQuestSummary {
    id: ID!
    title: String!
    description: String!
    difficulty: String!
    xpReward: Int!
    category: String!
    createdAt: String!
  }

  type SideQuestsResponse {
    success: Boolean!
    sideQuests: [SideQuestSummary!]!
  }

  type SideQuestResponse {
    success: Boolean!
    message: String!
    sideQuest: SideQuestSummary
    needsToComplete: Boolean
    activeShardsCount: Int
    existingSideQuest: ExistingSideQuest
  }

  type ExistingSideQuest {
    id: ID!
    title: String!
  }

  type CompleteSideQuestResponse {
    success: Boolean!
    message: String!
    xpEarned: Int!
    xpResult: XPResult
  }

  type GenerateCheckResponse {
    success: Boolean!
    canGenerate: Boolean!
    reasons: GenerateReasons!
  }

  type GenerateReasons {
    tooManyShards: Boolean!
    hasRecentSideQuest: Boolean!
    activeShardsCount: Int!
  }

  type CompleteMiniGoalResponse {
    success: Boolean!
    message: String!
    xpEarned: Int!
    xpResult: XPResult
    shardProgress: Int!
  }

  type GenerateTasksResponse {
    success: Boolean!
    message: String!
    tasks: [Task!]
    aiCallsRemaining: Int
    needsUpgrade: Boolean
  }

  # Analytics types
  input ActivityInput {
    tasksCompleted: Int
    xpEarned: Int
    shardsActive: Int
    hoursLogged: Int
  }

  type DailyData {
    date: String!
    tasksCompleted: Int!
    xpEarned: Int!
    shardsActive: Int!
  }

  type ProductivityResponse {
    success: Boolean!
    message: String
    weeklyData: [DailyData!]!
    monthlyData: [DailyData!]!
    insights: [String!]!
    struggleAreas: [String!]!
    averageCompletionRate: Float!
  }

  type StatsData {
    activeShards: Int!
    completedShards: Int!
    activeMinigoals: Int!
    completedMinigoals: Int!
    completionRate: Int!
  }

  type StatsResponse {
    success: Boolean!
    stats: StatsData!
  }

  # Notification types
  type NotificationData {
    id: ID!
    message: String!
    shardId: ID
    miniGoalId: ID
    read: Boolean!
    triggerAt: String!
    createdAt: String!
  }

  type NotificationsResponse {
    success: Boolean!
    notifications: [NotificationData!]!
  }

  type UnreadNotificationCountResponse {
    success: Boolean!
    count: Int!
  }

  input NotificationPreferencesInput {
    friendRequests: Boolean
    messages: Boolean
    shardInvites: Boolean
    shardUpdates: Boolean
    questDeadlines: Boolean
    achievements: Boolean
    quietHoursEnabled: Boolean
    quietHoursStart: String
    quietHoursEnd: String
    pushEnabled: Boolean
    emailEnabled: Boolean
  }

  type NotificationPreferenceData {
    friendRequests: Boolean!
    messages: Boolean!
    shardInvites: Boolean!
    shardUpdates: Boolean!
    questDeadlines: Boolean!
    achievements: Boolean!
    quietHoursEnabled: Boolean!
    quietHoursStart: String!
    quietHoursEnd: String!
    pushEnabled: Boolean!
    emailEnabled: Boolean!
  }

  type NotificationPreferencesResponse {
    success: Boolean!
    preferences: NotificationPreferenceData!
  }

  type NotificationPreferencesUpdateResponse {
    success: Boolean!
    message: String!
    preferences: NotificationPreferenceData!
  }

  # Report types
  type ReportData {
    id: ID!
    reason: String!
    status: String!
    reviewedAt: String
    resolution: String
    createdAt: String!
  }

  type ReportsResponse {
    success: Boolean!
    reports: [ReportData!]!
  }

  type UserInfo {
    id: ID!
    username: String!
  }

  type PendingReportData {
    id: ID!
    reporter: UserInfo!
    reportedUser: UserInfo!
    reason: String!
    details: String
    status: String!
    createdAt: String!
  }

  type PendingReportsResponse {
    success: Boolean!
    reports: [PendingReportData!]!
  }

  # Support types
  input CreateSupportFlagInput {
    issueType: String!
    title: String!
    description: String!
    priority: String
    attachments: [String!]
  }

  type SupportFlagData {
    id: ID!
    title: String!
    issueType: String!
    priority: String!
    status: String!
    resolution: String
    updatedAt: String!
    createdAt: String!
  }

  type SupportFlagsResponse {
    success: Boolean!
    flags: [SupportFlagData!]!
  }

  type SupportFlagWithUser {
    id: ID!
    user: UserInfo!
    title: String!
    issueType: String!
    priority: String!
    status: String!
    updatedAt: String!
    createdAt: String!
  }

  type AllSupportFlagsResponse {
    success: Boolean!
    flags: [SupportFlagWithUser!]!
  }

  type SupportFlagResponse {
    success: Boolean!
    message: String!
    flag: SupportFlagData!
  }

  # Chat attachment types
  input AttachmentInput {
    url: String!
    type: String!
    name: String
  }

  type Attachment {
    url: String!
    type: String!
    name: String
  }

  type ReactionData {
    userId: ID!
    emoji: String!
  }

  # ─── Admin ────────────────────────────────────────────────────────────────

  extend type Query {
    # Admin — Dashboard
    adminDashboard: AdminDashboardResponse!

    # Admin — User Management
    adminListUsers(search: String, page: Int, limit: Int): AdminUsersResponse!
    adminGetUser(userId: ID!): AdminUserDetailResponse!

    # Admin — Reports
    adminGetReports(status: String, page: Int, limit: Int): AdminReportsResponse!

    # Admin — Support
    adminGetSupportFlags(status: String, priority: String, page: Int, limit: Int): AdminSupportFlagsResponse!

    # Admin — Audit Trail
    adminGetAuditTrail(userId: ID, page: Int, limit: Int): AdminAuditResponse!

    # Admin — Shards
    adminGetShardOverview(status: String, page: Int, limit: Int): AdminShardsResponse!
  }

  extend type Mutation {
    # Admin OTP login
    requestAdminOtp(email: String!): MessageResponse!
    verifyAdminOtp(email: String!, otp: String!): AuthResponse!

    # Admin — User Management
    adminUpdateUser(userId: ID!, input: AdminUpdateUserInput!): AdminUpdateUserResponse!
  }

  input AdminUpdateUserInput {
    isActive: Boolean
    role: String
    strength: Int
    intelligence: Int
    charisma: Int
    endurance: Int
    creativity: Int
    xp: Int
    level: Int
    aiCredits: Int
    forceLogout: Boolean
  }

  type AdminDashboardResponse {
    success: Boolean!
    totalUsers: Int!
    activeToday: Int!
    totalShards: Int!
    shardsCreatedToday: Int!
    pendingReports: Int!
    openSupportFlags: Int!
    bannedUsers: Int!
    totalXPEarned: Float!
  }

  type AdminUserSummary {
    id: ID!
    username: String!
    email: String!
    role: String!
    isActive: Boolean!
    xp: Int!
    level: Int!
    currentStreak: Int!
    subscriptionTier: String
    lastLoginAt: String
    createdAt: String!
  }

  type AdminUsersResponse {
    success: Boolean!
    total: Int!
    page: Int!
    limit: Int!
    users: [AdminUserSummary!]!
  }

  type AdminUserDetail {
    id: ID!
    username: String!
    email: String!
    profilePic: String
    bio: String
    role: String!
    isActive: Boolean!
    emailVerified: Boolean!
    authProvider: String!
    xp: Int!
    level: Int!
    aiCredits: Int!
    strength: Int!
    intelligence: Int!
    charisma: Int!
    endurance: Int!
    creativity: Int!
    currentStreak: Int!
    longestStreak: Int!
    subscriptionTier: String
    achievements: [String!]!
    lastLoginAt: String
    createdAt: String!
  }

  type AdminUserDetailResponse {
    success: Boolean!
    message: String
    user: AdminUserDetail
  }

  type AdminUpdateUserResponse {
    success: Boolean!
    message: String!
    user: UserInfo
  }

  type AdminReportData {
    id: ID!
    reporter: UserInfo
    reportedUser: UserInfo
    reason: String!
    details: String
    status: String!
    resolution: String
    reportedItemType: String
    createdAt: String!
    reviewedAt: String
  }

  type AdminReportsResponse {
    success: Boolean!
    total: Int!
    page: Int!
    limit: Int!
    reports: [AdminReportData!]!
  }

  type AdminSupportUserInfo {
    id: ID!
    username: String!
    email: String
  }

  type AdminSupportFlagData {
    id: ID!
    user: AdminSupportUserInfo
    title: String!
    issueType: String!
    priority: String!
    status: String!
    description: String
    resolution: String
    createdAt: String!
    updatedAt: String!
  }

  type AdminSupportFlagsResponse {
    success: Boolean!
    total: Int!
    page: Int!
    limit: Int!
    flags: [AdminSupportFlagData!]!
  }

  type AuditEntry {
    id: ID!
    userId: String!
    task: String!
    details: String!
    createdAt: String!
  }

  type AdminAuditResponse {
    success: Boolean!
    total: Int!
    page: Int!
    limit: Int!
    entries: [AuditEntry!]!
  }

  type AdminShardSummary {
    id: ID!
    title: String!
    status: String!
    completion: Int!
    isPrivate: Boolean!
    isAnonymous: Boolean!
    owner: UserInfo
    createdAt: String!
    endDate: String
  }

  type AdminShardsResponse {
    success: Boolean!
    total: Int!
    page: Int!
    limit: Int!
    shards: [AdminShardSummary!]!
  }
`;