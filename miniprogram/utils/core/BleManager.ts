// miniprogram/utils/core/BleManager.ts

/**
 * 蓝牙管理类：负责硬件通讯和协议解析
 *
 * ESP32-S3 BLE数据帧格式 (极简版, 8字节):
 * - 字节 0:   帧标识 'F' (0x46)
 * - 字节 1-4: 力值 (int32, 小端序, 单位: raw counts)
 * - 字节 5-6: 角度 (int16, 小端序, 单位: 0.01度)
 * - 字节 7:   校验和 (前7字节异或)
 */
import { BLE_CONFIG } from "../shared/Constants";
import { getLastDeviceId, saveLastDeviceId } from "../storage/index";
/** 帧格式常量 */
const FRAME_MAGIC = 0x46; // 'F'
const FRAME_LEN = 8;

export class BleManager {
  // 单例模式：确保全局只有一个蓝牙连接
  private static instance: BleManager | null = null;
  private deviceId: string = "";
  private isConnected: boolean = false;
  private mockTimer: number | null = null;
  private connectionTimer: number | null = null; // 连接超时计时器
  private searchTimer: number | null = null; // 搜索决策计时器
  // 统计信息
  private totalFrames: number = 0;

  // 监听器引用（用于移除监听）
  private onDeviceFoundCallback:
    | ((res: WechatMiniprogram.OnBluetoothDeviceFoundCallbackResult) => void)
    | null = null;
  private onConnectionStateCallback:
    | ((
        res: WechatMiniprogram.OnBLEConnectionStateChangeCallbackResult,
      ) => void)
    | null = null;
  private onCharacteristicValueCallback:
    | ((
        res: WechatMiniprogram.OnBLECharacteristicValueChangeCallbackResult,
      ) => void)
    | null = null;

  // 信号--------------------------------------------------------------------------------------------
  /** 数据包信号：当收到解析好的数据时触发 */
  public onDataPacket: ((force: number, angle: number) => void) | null = null;
  /** 连接状态改变信号 */
  public onConnectionChanged: ((status: boolean) => void) | null = null;
  /** 连接中状态信号 */
  public onConnecting: ((isConnecting: boolean) => void) | null = null;
  /** 意外断开信号：当蓝牙意外断开时触发，用于通知MeasureEngine重置状态 */
  public onUnexpectedDisconnect: (() => void) | null = null;
  /** 发现多个设备时通知UI */
  public onDevicesDiscovered: ((list: any[]) => void) | null = null;

  // 函数----------------------------------------------------------------------------------------
  /** 单例模式：确保全局只有一个蓝牙连接 */
  static getInstance(): BleManager {
    if (!BleManager.instance) BleManager.instance = new BleManager();
    return BleManager.instance;
  }
  private foundDevices: any[] = []; // 搜索到的符合条件的设备列表
  private currentServiceId: string = ""; // 动态获取到的服务ID
  private currentCharId: string = ""; // 动态获取到的特征值ID（iOS 兼容）

  /** 开启连接流程 */
  async connect() {
    console.log("启动蓝牙流程...");
    this.foundDevices = [];
    this.onConnecting?.(true);
    try {
      // 先尝试停止之前的搜索，确保状态干净
      try {
        await wx.stopBluetoothDevicesDiscovery();
      } catch (e) {
        /* 忽略错误 */
      }

      // 尝试初始化
      try {
        await wx.openBluetoothAdapter();
      } catch (e) {
        console.log("适配器已在运行中");
      }

      // 给硬件一点时间切换状态
      await new Promise((resolve) => setTimeout(resolve, 200));

      //  allowDuplicatesKey 设为 true ---
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true, // 必须为 true，否则重复搜索搜不到
        interval: 0,
        success: () => {
          console.log("开始搜索...");

          // 2.5 秒决策逻辑
          if (this.searchTimer) clearTimeout(this.searchTimer);
          this.searchTimer = setTimeout(() => {
            this._makeSmartDecision();
          }, 2500);

          this.onDeviceFoundCallback = (res) => {
            res.devices.forEach((device) => {
              if (
                device.name?.includes("ESP32-forcedet") ||
                device.localName?.includes("ESP32-forcedet")
              ) {
                // 更新或添加设备
                const index = this.foundDevices.findIndex(
                  (d) => d.deviceId === device.deviceId,
                );
                (device as any).signalLevel = this._getSignalLevel(device.RSSI);

                if (index > -1) {
                  this.foundDevices[index] = device; // 更新现有设备的信号
                } else {
                  this.foundDevices.push(device); // 添加新设备
                }
                //this.onDevicesDiscovered?.(this.foundDevices);  //保持静默收集
              }
            });
          };
          wx.onBluetoothDeviceFound(this.onDeviceFoundCallback);
        },
        fail: (err) => {
          this._handleConnectionError("搜索失败", "无法启动蓝牙扫描");
        },
      });
    } catch (e) {
      this._handleConnectionError("初始化失败", "请检查蓝牙开关");
    }
  }
  /** 信号强度转等级逻辑 */
  private _getSignalLevel(rssi: number): number {
    if (rssi > -60) return 4;
    if (rssi > -70) return 3;
    if (rssi > -85) return 2;
    return 1;
  }
  /** 连接逻辑 */
  private _makeSmartDecision() {
    wx.stopBluetoothDevicesDiscovery();
    const list = this.foundDevices;
    const lastId = getLastDeviceId();

    // 场景 A: 发现上次连过的设备在附近 -> 自动重连
    // const lastDevice = list.find((d) => d.deviceId === lastId);
    // if (lastDevice) {
    //   console.log("识别到老设备，自动静默连接:", lastDevice.name);
    //   this._establishRealConnection(lastDevice.deviceId);
    //   return;
    // }

    // 场景 B: 只有一个新设备 -> 自动连接
    if (list.length === 1) {
      console.log("附近仅有一台设备，自动连接:", list[0].name);
      this._establishRealConnection(list[0].deviceId);
      return;
    }

    // 场景 C: 多个设备 -> 保持正在连接状态，UI 会通过 onDevicesDiscovered 信号显示列表
    if (list.length > 1) {
      console.log("发现多台设备，等待用户手动选择...");
      // 这里不需要额外操作，Page 监听 onDevicesDiscovered 会自动弹出列表
      const sorted = list.sort((a, b) => b.RSSI - a.RSSI);
      // 此时才发射信号给 Page，弹出列表
      this.onDevicesDiscovered?.(sorted);
      return;
    }

    // 场景 D: 没搜到
    if (list.length === 0) {
      this._handleConnectionError("未发现设备", "请确保设备已开机并在附近");
    }
  }

  public async connectToDevice(deviceId: string) {
    // 清除超时计时器 (因为已经手动选定了，不需要再等搜索超时)
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    // 调用私有实现
    return await this._establishRealConnection(deviceId);
  }
  /** 真实的物理连接过程 */
  private async _establishRealConnection(deviceId: string) {
    try {
      const sysInfo = wx.getSystemInfoSync();
      const isIOS = sysInfo.platform === "ios";

      await wx.createBLEConnection({ deviceId });
      this.deviceId = deviceId;
      saveLastDeviceId(deviceId);

      // iOS 必须的冷静期
      if (isIOS) await new Promise((resolve) => setTimeout(resolve, 1000));

      // 1. 获取服务
      const resService = await wx.getBLEDeviceServices({ deviceId });
      const customService = resService.services.find((s) =>
        s.uuid.includes("-"),
      );
      if (!customService) throw new Error("未找到动态服务ID");
      this.currentServiceId = customService.uuid;
      console.log("识别到服务 UUID:", this.currentServiceId);

      // 2. 获取特征值
      const resChar = await wx.getBLEDeviceCharacteristics({
        deviceId: this.deviceId,
        serviceId: this.currentServiceId,
      });

      console.log("--- 硬件特征值扫描开始 ---");
      resChar.characteristics.forEach((c) => {
        console.log(`发现特征值: ${c.uuid} | 权限:`, c.properties);
      });
      console.log("--- 硬件特征值扫描结束 ---");

      // iOS 大小写敏感
      const targetChar = resChar.characteristics.find(
        (c) => c.uuid.toLowerCase() === BLE_CONFIG.CHAR_UUID.toLowerCase(),
      );

      if (targetChar) {
        this.currentCharId = targetChar.uuid; // 存储硬件返回的实际 UUID（保留原始大小写）
      } else {
        // 容错处理：如果 UUID 对不上，尝试找第一个支持 Notify 的特征值
        const fallbackChar = resChar.characteristics.find(
          (c) => c.properties.notify,
        );
        if (fallbackChar) {
          console.warn(
            "UUID 严格匹配失败，自动降级使用支持 Notify 的特征值:",
            fallbackChar.uuid,
          );
          this.currentCharId = fallbackChar.uuid;
        } else {
          throw new Error("硬件未提供支持 Notify 的特征值");
        }
      }

      if (isIOS) await new Promise((resolve) => setTimeout(resolve, 800));

      this.isConnected = true;
      this.onConnecting?.(false);
      this.onConnectionChanged?.(true);

      this._startNotify();
    } catch (e: any) {
      this._handleConnectionError("连接失败", e.message || "握手失败");
    }
  }

  /** 开启硬件通知（支持 iOS 重试） */
  private _startNotify(retryCount: number = 0) {
    const maxRetries = 3;
    const charId = this.currentCharId || BLE_CONFIG.CHAR_UUID;
    const sysInfo = wx.getSystemInfoSync();
    const isIOS = sysInfo.platform === "ios";

    wx.notifyBLECharacteristicValueChange({
      deviceId: this.deviceId,
      serviceId: this.currentServiceId,
      characteristicId: charId, // 使用硬件返回的实际 UUID
      state: true,
      success: () => {
        console.log("BLE通知订阅成功");
        this.onCharacteristicValueCallback = (res) => {
          this._decodeAndEmit(res.value);
        };
        wx.onBLECharacteristicValueChange(this.onCharacteristicValueCallback);
      },
      fail: (err) => {
        if (isIOS && retryCount < maxRetries) {
          const delay = 500 * (retryCount + 1);
          console.warn(
            `iOS BLE通知订阅失败 (${retryCount + 1}/${maxRetries})，${delay}ms 后重试...`,
            err,
          );
          setTimeout(() => this._startNotify(retryCount + 1), delay);
        } else {
          console.error("BLE通知订阅失败", err);
        }
      },
    });
  }

  /**
   * 解析BLE数据帧并发射信号
   *
   * 极简帧结构: 8字节
   */
  private _decodeAndEmit(buffer: ArrayBuffer) {
    const result = this._parseFrame(buffer);
    if (!result) return;

    // 发射数据信号
    this.onDataPacket?.(result.force, result.angle);

    // 每100帧打印一次统计信息
    // if (this.totalFrames % 100 === 0) {
    //   console.log(`BLE统计: 帧=${this.totalFrames}`);
    // }
  }

  /**
   * 解析极简BLE数据帧
   * @param buffer 原始二进制数据
   * @returns 解析后的力值和角度，失败返回null
   */
  private _parseFrame(
    buffer: ArrayBuffer,
  ): { force: number; angle: number } | null {
    const data = new Uint8Array(buffer);

    // 检查长度
    if (data.length !== FRAME_LEN) {
      console.warn(
        `[BLE] 帧长度错误: ${data.length}字节, 期望${FRAME_LEN}字节`,
      );
      return null;
    }

    // 检查帧标识
    if (data[0] !== FRAME_MAGIC) {
      console.warn(`[BLE] 无效帧标识: 0x${data[0].toString(16)}`);
      return null;
    }

    // 校验和验证
    let checksum = 0;
    for (let i = 0; i < 7; i++) {
      checksum ^= data[i];
    }
    if (checksum !== data[7]) {
      console.warn(
        `[BLE] 校验和错误: 计算值0x${checksum.toString(16)}, 接收值0x${data[7].toString(16)}`,
      );
      return null;
    }

    // 解析数据 (小端序)
    const view = new DataView(buffer);
    const forceRaw = view.getInt32(1, true); // 力值: int32
    const angleX100 = view.getInt16(5, true); // 角度: int16, 单位0.01度

    // 力值处理: 小于0则显示为0
    const force = Math.max(0, forceRaw * 0.001); //单位变成kg
    // 角度处理: 取绝对值, 转换为度
    const angle = Math.abs(angleX100 * 0.01);

    // 更新统计
    this.totalFrames++;

    return { force, angle };
  }

  // --- 模拟器逻辑 -----------------------------------------------------------------------------------------------
  /** 模拟连接成功的过程 */
  private _simulateConnection() {
    console.warn("当前处于[模拟模式]：正在伪造连接...");

    // 模拟 1秒后连接成功
    setTimeout(() => {
      // 连接成功，清除超时计时器
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }

      this.isConnected = true;
      this.onConnecting?.(false); // 连接成功，结束正在连接状态
      this.onConnectionChanged?.(true);
      console.log("模拟连接成功！开始产生模拟数据...");
      this._startMockDataStream();
    }, 1000);
  }

  /** 模拟数据流 - 默认模式：只产生0~4N/°的随机数 */
  private _startMockDataStream() {
    if (this.mockTimer) clearInterval(this.mockTimer);

    console.log("模拟数据模式: 默认模式 (0~4N/°)");

    // 每10ms发送一帧 (模拟100Hz采样)
    this.mockTimer = setInterval(() => {
      // 构造极简模拟帧 (8字节)
      const buffer = new ArrayBuffer(FRAME_LEN);
      const view = new DataView(buffer);
      const data = new Uint8Array(buffer);

      // 默认模式: 0~4N/°的随机数
      const force = Math.random() * 4;
      const angle = Math.random() * 4;

      // 帧头
      data[0] = FRAME_MAGIC;

      // 力值 (int32, 单位: raw counts, 需要乘以100因为解析时会乘以0.01)
      view.setInt32(1, Math.floor(force * 100), true);

      // 角度 (int16, 单位0.01度)
      view.setInt16(5, Math.floor(angle * 100), true);

      // 校验和
      let checksum = 0;
      for (let i = 0; i < 7; i++) {
        checksum ^= data[i];
      }
      data[7] = checksum;

      // 调用解析函数
      this._decodeAndEmit(buffer);
    }, 10);
  }

  /** 触发三阶段模拟数据（点击开始测量后调用） */
  triggerThreePhaseMockData() {
    if (!BLE_CONFIG.MOCK_MODE) return;
    if (this.mockTimer) clearInterval(this.mockTimer);

    // 模拟数据阶段控制
    // 阶段1: 开始1s内，力/角度值为0~4N/°的随机数
    // 阶段2: 随机1~3s的40~50N/°之间的随机数
    // 阶段3: 最后1s内，力/角度值为0~4N/°的随机数

    const PHASE1_DURATION = 1000; // 阶段1持续1秒
    const PHASE3_DURATION = 1000; // 阶段3持续1秒
    const PHASE2_MIN_DURATION = 1000; // 阶段2最小1秒
    const PHASE2_MAX_DURATION = 3000; // 阶段2最大3秒

    // 随机生成阶段2的持续时间
    const phase2Duration =
      PHASE2_MIN_DURATION +
      Math.random() * (PHASE2_MAX_DURATION - PHASE2_MIN_DURATION);
    const totalDuration = PHASE1_DURATION + phase2Duration + PHASE3_DURATION;

    let startTime = Date.now();
    let currentPhase = 1;

    console.log(
      `模拟数据模式: 三阶段模式 - 阶段1(1s) -> 阶段2(${(phase2Duration / 1000).toFixed(1)}s) -> 阶段3(1s), 总时长${(totalDuration / 1000).toFixed(1)}s`,
    );

    // 每10ms发送一帧 (模拟100Hz采样)
    this.mockTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;

      // 判断当前阶段
      if (elapsed < PHASE1_DURATION) {
        currentPhase = 1;
      } else if (elapsed < PHASE1_DURATION + phase2Duration) {
        currentPhase = 2;
      } else if (elapsed < totalDuration) {
        currentPhase = 3;
      } else {
        // 三阶段结束后，恢复默认模式
        this._startMockDataStream();
        return;
      }

      // 构造极简模拟帧 (8字节)
      const buffer = new ArrayBuffer(FRAME_LEN);
      const view = new DataView(buffer);
      const data = new Uint8Array(buffer);

      let force = 0;
      let angle = 0;

      // 根据阶段生成不同的数据
      if (currentPhase === 1 || currentPhase === 3) {
        // 阶段1和3: 0~4N/°的随机数
        force = Math.random() * 4;
        angle = Math.random() * 4;
      } else {
        // 阶段2: 40~50N/°之间的随机数
        force = 40 + Math.random() * 10;
        angle = 40 + Math.random() * 10;
      }

      // 帧头
      data[0] = FRAME_MAGIC;

      // 力值 (int32, 单位: raw counts, 需要乘以100因为解析时会乘以0.01)
      view.setInt32(1, Math.floor(force * 100), true);

      // 角度 (int16, 单位0.01度)
      view.setInt16(5, Math.floor(angle * 100), true);

      // 校验和
      let checksum = 0;
      for (let i = 0; i < 7; i++) {
        checksum ^= data[i];
      }
      data[7] = checksum;

      // 调用解析函数
      this._decodeAndEmit(buffer);
    }, 10);
  }

  /** 断开连接并清理 */
  async disconnect() {
    // 清除连接超时计时器
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    if (BLE_CONFIG.MOCK_MODE) {
      if (this.mockTimer) clearInterval(this.mockTimer);
      this.mockTimer = null;
      this.isConnected = false;
      this.onConnectionChanged?.(false);
      return;
    }

    // 真实断开逻辑
    // 1. 移除所有监听器
    this._removeAllListeners();

    // 2. 停止蓝牙设备搜索
    try {
      wx.stopBluetoothDevicesDiscovery();
      console.log("已停止蓝牙设备搜索");
    } catch (e) {
      // 忽略错误
    }

    // 3. 关闭BLE连接
    if (this.deviceId) {
      try {
        await wx.closeBLEConnection({ deviceId: this.deviceId });
        console.log("BLE连接已断开");
      } catch (e) {
        console.error("断开连接失败", e);
      }
    }

    // 4. 关闭蓝牙适配器
    // try {
    //   await wx.closeBluetoothAdapter();
    //   console.log("蓝牙适配器已关闭");
    // } catch (e) {
    //   console.error("关闭蓝牙适配器失败", e);
    // }

    // 5. 清空设备ID和状态
    this.deviceId = "";
    this.isConnected = false;
    this.onConnectionChanged?.(false);

    // 6. 重置统计
    this.totalFrames = 0;
  }

  /** 获取连接状态 */
  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /** 获取统计信息 */
  getStats() {
    return {
      totalFrames: this.totalFrames,
    };
  }

  /**
   * 处理蓝牙意外断开
   */
  private _handleUnexpectedDisconnect() {
    console.log("处理蓝牙意外断开...");

    // 清空设备ID和连接状态
    this.deviceId = "";
    this.isConnected = false;

    this.totalFrames = 0;

    this.onUnexpectedDisconnect?.();

    this.onConnectionChanged?.(false);

    this._removeAllListeners();

    try {
      wx.closeBluetoothAdapter({
        success: () => {
          console.log("意外断开后，蓝牙适配器已关闭");
        },
        fail: (err) => {
          console.warn("关闭蓝牙适配器失败", err);
        },
      });
    } catch (e) {
      // 忽略错误
    }
  }

  /**
   * 处理连接错误
   * @param title 错误标题
   * @param message 错误详细信息
   */
  private _handleConnectionError(title: string, message: string) {
    // 清除超时计时器
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    // 移除所有监听器
    this._removeAllListeners();

    // 停止蓝牙搜索
    try {
      wx.stopBluetoothDevicesDiscovery();
    } catch (e) {
      // 忽略错误
    }

    // 显示错误提示框
    wx.showModal({
      title: title,
      content: message,
      showCancel: false,
      confirmText: "确定",
    });

    // 触发连接状态改变
    this.isConnected = false;
    this.onConnecting?.(false); // 连接失败，结束正在连接状态
    this.onConnectionChanged?.(false);
  }

  /**
   * 移除所有蓝牙监听器
   */
  private _removeAllListeners() {
    // 移除设备发现监听
    if (this.onDeviceFoundCallback) {
      try {
        wx.offBluetoothDeviceFound(this.onDeviceFoundCallback);
      } catch (e) {
        // 忽略错误
      }
      this.onDeviceFoundCallback = null;
    }

    // 移除连接状态监听
    if (this.onConnectionStateCallback) {
      try {
        wx.offBLEConnectionStateChange(this.onConnectionStateCallback);
      } catch (e) {
        // 忽略错误
      }
      this.onConnectionStateCallback = null;
    }

    // 移除特征值变化监听
    if (this.onCharacteristicValueCallback) {
      try {
        wx.offBLECharacteristicValueChange(this.onCharacteristicValueCallback);
      } catch (e) {
        // 忽略错误
      }
      this.onCharacteristicValueCallback = null;
    }
  }
}
