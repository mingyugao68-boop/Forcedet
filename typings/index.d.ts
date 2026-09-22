/// <reference path="./types/index.d.ts" />

/// <reference path="./types/index.d.ts" />

interface IAppOption {
  globalData: {
    userInfo?: WechatMiniprogram.UserInfo
  }

  userInfoReadyCallback?: WechatMiniprogram.GetUserInfoSuccessCallback

  initDatabaseIndexes(): Promise<void>
}