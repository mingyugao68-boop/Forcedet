// app.ts
App<IAppOption>({
  globalData: {},
  onLaunch() {
    // 初始化云开发环境
    if (wx.cloud) {
      wx.cloud.init({
        //zjm:环境ID 'cloud1-0g2binqq598c83e1',
        //zqy：cloud1-3gqgot2h224a5a99
        env: "cloud1-d9gl1jtmn94a4fe15",
        traceUser: true, // 自动上报用户信息
      });

      // 初始化数据库索引（优化查询性能）
      this.initDatabaseIndexes();
    }

    // 展示本地存储能力
    const logs = wx.getStorageSync("logs") || [];
    logs.unshift(Date.now());
    wx.setStorageSync("logs", logs);

    // 登录
    wx.login({
      success: (res) => {
        console.log("res.code:", res.code);
        // 发送 res.code 到后台换取 openId, sessionKey, unionId
      },
    });
  },

  /**
   * 初始化数据库索引
   * 提升查询性能，特别是趋势分析和条件查询
   */
  async initDatabaseIndexes() {
    try {
     

      // 为 featureNote 集合创建复合索引
      // 注意：微信云开发数据库索引需要在云控制台手动创建
      // 这里仅作为提示，实际索引创建请参考文档：
      // https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/database/indexes.html

      console.log("数据库索引初始化提示：");
      console.log("请在云开发控制台为 featureNote 集合创建以下索引：");
      console.log(
        "1. { bodyPart: 1, action: 1, timestamp: -1 } - 用于趋势查询",
      );
      console.log("2. { side: 1, bodyPart: 1, timestamp: -1 } - 用于部位统计");
      console.log("3. { timestamp: -1 } - 用于历史列表查询");
    } catch (error) {
      console.error("数据库索引初始化失败:", error);
    }
  },
});
