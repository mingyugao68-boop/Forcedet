// miniprogram/utils/shared/Constants.ts
//定义全局常量

/**蓝牙连接参数 - 需要与ESP32-S3.ino保持一致*/
export const BLE_CONFIG = {
  SERVICE_UUID: "5e8d4b2a-7b01-4b77-a9fe-7bbd140bdf76", // 服务UUID
  CHAR_UUID: "b4f36734-527d-4c6b-9cd9-5cfa1a260c60", // 数据流特征UUID
  CTRL_CHAR_UUID: "cf9fb4ac-858f-44b1-a0d5-b8f7bfcfdf13", // 控制特征UUID
  DEVICE_NAME: "ESP32-forcedet", // 设备名称
  MOCK_MODE: false, // 关闭模拟模式，使用真实BLE
};

/**测量阈值设定*/
export const MEASURE_CONFIG = {
  TRIGGER_THRESHOLD: 5, // 触发阈值: 5kg
  STOP_THRESHOLD: 2, //结束阈值: 2kg (稍微低于触发值，防止抖动)
  STOP_DURATION_FRAME: 15, // 持续帧数: 50ms / 3.3ms ≈ 15帧
  SAMPLE_RATE: 300, // 300Hz
  TIMEOUT_MS: 10000, // 10秒超时，自动终止测试
};

/**滤波器配置参数*/
export const FILTER_CONFIG = {
  // 一阶低通滤波系数 (0 < α ≤ 1)
  // α越小，滤波效果越强（更平滑，响应慢）
  // α越大，响应越快（噪声抑制弱）
  // 推荐值: 0.15 ~ 0.25
  FORCE_ALPHA: 0.15, // 力值滤波系数
  ANGLE_ALPHA: 0.3, // 角度滤波系数（角度变化较快，可稍大）

  // 是否启用滤波（调试时可关闭）
  ENABLE_FILTER: true,
};
