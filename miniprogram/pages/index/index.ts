// miniprogram/pages/index/index.ts

import { BleManager, MeasureEngine } from "../../utils/core/index";
import {
  MMTPainter,
  FullscreenMMTPainter,
  HistoryPainter,
  FullscreenHistoryPainter,
  ROMRealtimePainter,
  ROMHistoryPainter,
  FullscreenROMPainter,
  FullscreenROMHistoryPainter,
} from "../../utils/painters/index";
import {
  MMTStorage,
  ROMStorage,
  FileExporter,
  CloudStorage,
  FeatureNoteManager,
} from "../../utils/storage/index";
import { MeasureState } from "../../utils/shared/types";
import { CommonUtils } from "../../utils/shared/CommonUtils";
import { BLE_CONFIG } from "../../utils/shared/Constants";

let lastUiUpdateTime = 0;
const UI_UPDATE_INTERVAL = 100; // 限制 UI 刷新频率为 10Hz (100ms)，节省性能

Page({
  data: {
    ec: { lazyLoad: true },
    isNetworkConnected: true, // 网络连接状态
    showDeviceList: false, //是否要展示多个蓝牙设备的连接弹出窗口
    deviceList: [], //多个蓝牙设备列表
    // 仅存储 UI 需要绑定的属性
    display: {
      force: 0,
      angle: 0,
      peak: 0,
      angleMax: 0,
      rfd: 0,
      duration: 0,
      activity: 0,
      angleDiff: 0, //角度变化
      percentDiff: 0, //百分比差异
    },
    isConnected: false,
    isConnecting: false, //是否正在连接中
    isMeasuring: false, //是否正在测量中
    statusText: "未连接",
    deviceName: "None", // 设备名称显示
    isBtnDisabled: false, //控制按钮禁用状态
    side: "L", // 默认左侧
    limb: "Upper", // 默认上肢
    sideIndex: 0,
    sideOptions: ["左", "右"],
    bodyPartIndex: 0,
    bodyPartOptions: [
      "颈椎",
      "胸椎",
      "腰椎",
      "肩关节",
      "肘关节",
      "腕关节",
      "髋关节",
      "膝关节",
      "踝关节",
    ],
    rotationIndex: 0,
    rotationOptions: ["屈曲", "伸展", "旋转", "侧屈"], // 默认颈椎的动作选项
    lastResult: null as any, // 暂存最后一次测量结果
    historyDiff: { val: "0", percent: "0%", isIncrease: true }, //存放最近测试趋势卡片的历史数据对比
    romTrend: { percent: "0%", isIncrease: true }, //存放ROM卡片需要的数据
    // 自定义选择器弹窗相关
    showPickerModal: false,
    pickerColumns: [] as any[],
    // 全屏弹窗相关
    showFullscreen: false,
    showROMFullscreen: false,
    showHistoryFullscreen: false,
    showROMHistoryFullscreen: false,
    // 全屏标签
    historyFullscreenLabel: "",
    romHistoryFullscreenLabel: "",
  },

  // 身体部位与动作的映射关系
  bodyPartActionMap: {
    颈椎: ["屈曲", "伸展", "旋转", "侧屈"],
    胸椎: ["屈曲", "伸展", "旋转", "侧屈"],
    腰椎: ["屈曲", "伸展", "旋转", "侧屈"],
    肩关节: ["屈曲", "伸展", "内旋", "外旋", "内收", "外展"],
    肘关节: ["屈曲", "伸展"],
    腕关节: ["屈曲", "伸展", "尺偏", "桡偏"],
    髋关节: ["屈曲", "伸展", "内旋", "外旋", "内收", "外展"],
    膝关节: ["屈曲", "伸展"],
    踝关节: ["背屈", "跖屈", "内翻", "外翻"],
  } as Record<string, string[]>,
  // 缓存单例引用
  ble: null as BleManager | null,
  engine: null as MeasureEngine | null,
  painter: null as MMTPainter | null,
  fullscreenPainter: null as FullscreenMMTPainter | null,
  historyPainter: null as HistoryPainter | null,
  romRealtimePainter: null as ROMRealtimePainter | null,
  romHistoryPainter: null as ROMHistoryPainter | null,
  fullscreenROMPainter: null as FullscreenROMPainter | null,
  fullscreenHistoryPainter: null as FullscreenHistoryPainter | null,
  fullscreenROMHistoryPainter: null as FullscreenROMHistoryPainter | null,
  // 标记当前测量数据是否已保存到云端
  hasSavedToCloud: false,

  onLoad() {
    this.ble = BleManager.getInstance();
    this.engine = MeasureEngine.getInstance();
    this.painter = new MMTPainter("forceCanvas", this);
    this.historyPainter = new HistoryPainter("historyCanvas", this);
    this.romRealtimePainter = new ROMRealtimePainter("romRealtimeCanvas", this);
    this.romHistoryPainter = new ROMHistoryPainter("romHistoryCanvas", this);
    // 初始化网络状态检测
    this.checkNetworkStatus();
    // 监听网络状态变化
    wx.onNetworkStatusChange((res) => {
      this.setData({
        isNetworkConnected: res.isConnected,
      });
      // 网络恢复时重新初始化所有Canvas并刷新趋势图
      if (res.isConnected) {
        // 延迟执行，等待DOM渲染完成
        setTimeout(() => {
          this.reinitAllCanvases();
          const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
          const action = this.data.rotationOptions[this.data.rotationIndex];
          this.refreshTrendCharts(bodyPart, action);
        }, 100);
      }
    });

    // 1. 监听连接信号
    this.ble.onConnectionChanged = (status) => {
      this.setData({
        isConnected: status,
        statusText: status ? "已连接" : "未连接",
        isConnecting: false, // 连接状态改变时，重置正在连接状态
        // 断开连接时重置测量状态
        isMeasuring: status ? this.data.isMeasuring : false,
        // 连接时显示设备名称，断开时显示None
        deviceName: status ? BLE_CONFIG.DEVICE_NAME : "None",
      });
    };

    // 1.1 监听正在连接状态
    this.ble.onConnecting = (isConnecting) => {
      this.setData({
        isConnecting: isConnecting,
        statusText: isConnecting ? "正在连接" : this.data.statusText,
      });
    };

    // 2. 监听实时 Tick 信号
    this.engine.onTick = (f, a) => {
      const now = Date.now();
      // 每 16.66ms 更新一次 UI 数字
      if (now - lastUiUpdateTime > UI_UPDATE_INTERVAL) {
        this.setData({
          "display.force": Math.floor(f), // 取整，防止小数位乱跳
          "display.angle": Math.floor(a),
        });
        lastUiUpdateTime = now;
      }
    };

    // 3. 监听结果就绪信号
    this.engine.onResultReady = async (res) => {
      this.lastResult = res; // 存下来用于导出
      // 保存到历史记录
      MMTStorage.save(res);
      ROMStorage.save(res);

      // 获取当前测量的部位和动作
      const bodyPartName = this.data.bodyPartOptions[this.data.bodyPartIndex];
      const actionName = this.data.rotationOptions[this.data.rotationIndex];

      // 从云端获取趋势对比数据
      const [historyDiff, romTrend] = await Promise.all([
        FeatureNoteManager.getTrendComparison(bodyPartName, actionName),
        FeatureNoteManager.getRomTrendComparison(bodyPartName, actionName),
      ]);

      this.setData({
        "display.peak": res.peakValue,
        "display.rfd": res.rfdValue,
        "display.duration": res.durationValue,
        "display.activity": res.activityValue,
        "display.angleDiff": res.imuAngle.toFixed(1),
        "display.percentDiff": res.percentageDiff.toFixed(1),
        "display.angleMax": res.imuPeak.toFixed(1),
        historyDiff,
        romTrend,
      });

      // 逻辑决策树：先判断是否强制停止
      if (res.isForcedStopped) {
        wx.showModal({
          title: "测量超时",
          content: "传感器数据持续未回落，已强制结束。请检查设备是否异常。",
          showCancel: false,
        });
        return;
      }

      // 根据当前侧别显示不同的提示
      if (this.data.sideIndex === 0) {
        // 当前为左侧，测量结束后提示是否进行右侧测量
        wx.showModal({
          title: "测量完成",
          content: "左侧测量已完成，是否进行右侧测量？",
          success: (sm) => {
            if (sm.confirm) {
              // 用户点击确认，切换到右侧并开始测量
              this.setData({
                sideIndex: 1,
                side: "R",
              });
              // 生成新的文件名并开始测量
              const bodyPartName =
                this.data.bodyPartOptions[this.data.bodyPartIndex];
              const actionName =
                this.data.rotationOptions[this.data.rotationIndex];
              const timeStr = CommonUtils.getFormattedTimestamp();
              const fileName = `左右_${bodyPartName}_${actionName}-${timeStr}`;
              // 使用 startSecondMeasure 保留左侧数据用于对比显示
              this.engine!.startSecondMeasure(fileName);
            }
          },
        });
      } else {
        // 当前为右侧，测量结束后显示提示，1秒后消失
        wx.showToast({
          title: "测量已完成",
          icon: "success",
          duration: 1000,
        });
        // 第二轮测量结束后，自动将侧别重置为左侧
        this.setData({
          sideIndex: 0,
          side: "L",
        });
      }
    };

    // 4. 监听状态改变
    this.engine.onStateChanged = (state: MeasureState) => {
      //console.log(state);
      const statusMap = ["待机", "计算基准", "准备测量", "测量中...", "完成"];
      const shouldDisable = state === 1 || state === 2 || state === 3;
      const isMeasuring = state === 3; // 状态3为测量中
      this.setData({
        statusText: statusMap[state],
        isBtnDisabled: shouldDisable,
        isMeasuring: isMeasuring,
      }); //因为MeasureState实际上是int类型
    };

    // 5.监听发现多个设备的信号
    this.ble.onDevicesDiscovered = (list) => {
      // 如果已经连上了，就不弹了
      if (this.data.isConnected) return;

      // 按信号强度排序 (RSSI 是负数，大的排前面)
      const sorted = list.sort((a, b) => b.RSSI - a.RSSI);
      this.setData({
        deviceList: sorted,
        showDeviceList: true,
        statusText: "请选择设备",
      });
    };
  },

  /** 用户在列表中点选设备 */
  onSelectDevice(e: any) {
    const deviceId = e.currentTarget.dataset.id;
    this.setData({ showDeviceList: false }); //关闭弹窗
    this.ble!.connectToDevice(deviceId);
  },
  /** 关闭设备选择弹窗 */
  onCloseDeviceList() {
    this.setData({
      showDeviceList: false,
      // 如果用户取消了选择，重置“正在连接”的状态
      isConnecting: false,
      statusText: this.data.isConnected ? "已连接" : "未连接",
    });

    //如果用户主动关闭了列表，停止蓝牙搜索以省电
    wx.stopBluetoothDevicesDiscovery();
  },
  /** 页面显示时检查Canvas有效性 */
  onShow() {
    // 检查主Canvas是否有效，无效则重新初始化
    if (this.painter && !this.painter.isReady()) {
      console.log("主Canvas已失效，重新初始化...");
      this.painter = new MMTPainter("forceCanvas", this);
    }
    if (this.historyPainter && !this.historyPainter.isReady()) {
      console.log("历史Canvas已失效，重新初始化...");
      this.historyPainter = new HistoryPainter("historyCanvas", this);
    }
    if (this.romRealtimePainter && !this.romRealtimePainter.isReady()) {
      console.log("ROM实时Canvas已失效，重新初始化...");
      this.romRealtimePainter = new ROMRealtimePainter(
        "romRealtimeCanvas",
        this,
      );
    }
    if (this.romHistoryPainter && !this.romHistoryPainter.isReady()) {
      console.log("ROM历史Canvas已失效，重新初始化...");
      this.romHistoryPainter = new ROMHistoryPainter("romHistoryCanvas", this);
    }

    // 初始化趋势图筛选条件
    const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
    const action = this.data.rotationOptions[this.data.rotationIndex];
    this.refreshTrendCharts(bodyPart, action);
  },

  /** 连接/断开设备 */
  onTapConnect() {
    if (this.data.isConnected) {
      // 已连接，弹出确认框
      wx.showModal({
        title: "确认断开连接？",
        content: "",
        success: (res) => {
          if (res.confirm) {
            // 用户点击"确定"，执行断开
            this.ble!.disconnect();
          }
          // 用户点击"取消"，不做任何操作
        },
      });
    } else {
      // 未连接，执行连接
      this.ble!.connect();
    }
  },

  /** 开始/停止测量 */
  onTapMeasure() {
    // 如果按钮被禁用（正在校准、准备或测量中），执行停止
    if (this.data.isBtnDisabled) {
      this.engine!.stopMeasure();
      return;
    }
    // 未在测量，执行开始
    if (!this.data.isConnected) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    // 重置图表状态
    this.painter?.resetView();
    this.romRealtimePainter?.resetView();
    // 重置保存标记
    this.hasSavedToCloud = false;
    // 自动命名策略：Measure-侧别_部位_动作-时间戳
    const sideName = this.data.sideIndex === 0 ? "左" : "右";
    const bodyPartName = this.data.bodyPartOptions[this.data.bodyPartIndex];
    const actionName = this.data.rotationOptions[this.data.rotationIndex];
    const timeStr = CommonUtils.getFormattedTimestamp();
    const fileName = `${sideName}_${bodyPartName}_${actionName}-${timeStr}`;
    this.engine!.startMeasure(fileName);
  },

  handleTouchStart(e: any) {
    this.painter?.onTouchStart(e);
  },

  handleTouchMove(e: any) {
    this.painter?.onTouchMove(e);
  },

  handleTouchEnd() {
    this.painter?.onTouchEnd();
  },

  /** 侧别选择 */
  onSelectSide(e: any) {
    if (this.data.isBtnDisabled) return; // 测量中禁止切换标签
    const val = e.currentTarget.dataset.val;
    this.setData({ side: val });
  },

  /** 部位选择 - 联动更新动作选项 */
  onBodyPartChange(e: any) {
    if (this.data.isBtnDisabled) return;
    const index = Number(e.detail.value);
    const selectedBodyPart = this.data.bodyPartOptions[index];

    // 获取该部位对应的动作选项
    const newRotationOptions = this.bodyPartActionMap[selectedBodyPart] || [];

    // 更新部位索引、动作选项，并重置动作索引为0
    this.setData({
      bodyPartIndex: index,
      rotationOptions: newRotationOptions,
      rotationIndex: 0, // 重置动作选择为第一个
      limb: index < 6 ? "Upper" : "Lower", // 前6个为上肢，后3个为下肢
    });

    // 刷新趋势图
    this.refreshTrendCharts(selectedBodyPart, newRotationOptions[0]);
  },

  /** 侧别下拉框选择 */
  onSideChange(e: any) {
    const index = Number(e.detail.value);
    this.setData({
      sideIndex: index,
      side: index === 0 ? "L" : "R",
    });
  },

  /** 动作下拉框选择 */
  onRotationChange(e: any) {
    const index = Number(e.detail.value);
    this.setData({
      rotationIndex: index,
    });

    // 刷新趋势图
    const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
    const action = this.data.rotationOptions[index];
    this.refreshTrendCharts(bodyPart, action);
  },

  /** 打开自定义选择器弹窗 */
  onOpenPickerModal() {
    if (this.data.isBtnDisabled) return;

    // 构建 Vant Picker 的列数据
    const pickerColumns = this.buildPickerColumns();

    this.setData({
      showPickerModal: true,
      pickerColumns,
    });
  },

  /**
   * 构建 Vant Picker 的列数据
   * 格式: [{ values: [...] }, { values: [...] }]
   */
  buildPickerColumns(): any[] {
    // 第一列: 部位
    const bodyPartColumn = this.data.bodyPartOptions.map((part, index) => ({
      name: part,
      index: index,
    }));

    // 第二列: 动作
    const currentBodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
    const actions = this.bodyPartActionMap[currentBodyPart] || [];
    const actionColumn = actions.map((action, index) => ({
      name: action,
      index: index,
    }));

    return [{ values: bodyPartColumn }, { values: actionColumn }];
  },

  /** 关闭自定义选择器弹窗 */
  onClosePickerModal() {
    this.setData({ showPickerModal: false });
  },

  /**
   * 选择器滚动变化
   * Vant Picker 的 change 事件参数: { detail: { picker, value, index } }
   * picker: Picker 实例,可以通过 picker.setColumnValues() 更新列数据
   */
  onPickerModalChange(e: any) {
    const { picker, value, index } = e.detail;

    // 如果是第一列(部位)变化,需要更新第二列(动作)
    if (index === 0) {
      const selectedBodyPart = value[0];
      const newBodyPart = selectedBodyPart.name;
      const newActions = this.bodyPartActionMap[newBodyPart] || [];

      // 更新第二列数据
      const actionColumn = newActions.map((action, idx) => ({
        name: action,
        index: idx,
      }));

      // 使用 picker 实例更新第二列
      picker.setColumnValues(1, actionColumn);

      // 触觉反馈
      wx.vibrateShort({ type: "light" });
    }
  },

  /**
   * 确认选择
   * Vant Picker 的 confirm 事件参数: { detail: { value, index } }
   */
  onConfirmPickerModal(e: any) {
    const { value, index } = e.detail;

    const selectedBodyPart = value[0];
    const selectedAction = value[1];

    const bodyPartIndex = selectedBodyPart.index;
    const actionIndex = selectedAction.index;
    const bodyPart = selectedBodyPart.name;
    const actions = this.bodyPartActionMap[bodyPart] || [];

    this.setData({
      bodyPartIndex,
      rotationIndex: actionIndex,
      rotationOptions: actions,
      limb: bodyPartIndex < 6 ? "Upper" : "Lower",
      showPickerModal: false,
    });

    // 触觉反馈
    wx.vibrateShort({ type: "medium" });

    // 刷新趋势图
    this.refreshTrendCharts(bodyPart, actions[actionIndex]);
  },
  /** 保存数据：云端存储 + 特征数据保存 + 询问是否本地预览 */
  async onTapSaveData() {
    if (!this.lastResult) {
      wx.showToast({ title: "没有可保存的数据", icon: "none" });
      return;
    }

    // 获取测量轮次信息
    const loopIndex = this.engine?.getCurrentLoopIndex() || 1;
    const firstLoopResult =
      loopIndex === 2 ? this.engine?.getFirstLoopResult() : null;

    // 如果数据已保存，直接询问是否预览
    if (this.hasSavedToCloud) {
      wx.showModal({
        title: "提示",
        content: "数据已上传至云端\n是否进行本地预览数据？",
        showCancel: true,
        cancelText: "否",
        confirmText: "是",
        success: async (res) => {
          if (res.confirm) {
            try {
              await FileExporter.exportToCsv(this.lastResult!, firstLoopResult);
            } catch (error) {
              console.error("打开本地预览失败:", error);
              wx.showToast({
                title: "预览失败",
                icon: "none",
                duration: 2000,
              });
            }
          }
        },
      });
      return;
    }

    wx.showLoading({ title: "正在保存...", mask: true });

    try {
      // 优化策略：同步等待所有上传完成，提供完整的进度反馈
      // 1. 先保存特征数据
      const featureNoteResult = await FeatureNoteManager.saveFeatureNote(
        this.lastResult,
        firstLoopResult,
      );

      // 2. 上传到云存储
      const cloudResult = await CloudStorage.uploadToCloud(
        this.lastResult,
        firstLoopResult,
      );

      // 3. 隐藏加载提示
      wx.hideLoading();

      // 5. 如果特征数据保存成功，刷新趋势图并标记已保存
      if (featureNoteResult.success) {
        console.log("刷新趋势图...");
        await this.historyPainter?.refresh();
        await this.romHistoryPainter?.refresh();
        this.hasSavedToCloud = true;

        // 刷新趋势对比数据
        const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
        const action = this.data.rotationOptions[this.data.rotationIndex];
        const [historyDiff, romTrend] = await Promise.all([
          FeatureNoteManager.getTrendComparison(bodyPart, action),
          FeatureNoteManager.getRomTrendComparison(bodyPart, action),
        ]);
        this.setData({ historyDiff, romTrend });
      }

      // 6. 显示保存结果并询问是否预览
      const successList = [];
      const failList = [];

      if (cloudResult.success) {
        successList.push("CSV文件已上传到云存储");
      } else {
        failList.push(`云存储上传失败: ${cloudResult.message}`);
      }

      if (featureNoteResult.success) {
        successList.push("特征数据已保存到数据库");
      } else {
        failList.push(`特征数据保存失败: ${featureNoteResult.message}`);
      }

      // 根据保存结果显示不同的提示
      if (failList.length === 0) {
        // 全部成功：询问是否预览
        wx.showModal({
          title: "保存成功",
          content: "数据已上传至云端\n是否进行本地预览数据？",
          showCancel: true,
          cancelText: "否",
          confirmText: "是",
          success: async (res) => {
            if (res.confirm) {
              // 用户点击"是"，打开本地预览
              try {
                await FileExporter.exportToCsv(
                  this.lastResult!,
                  firstLoopResult,
                );
              } catch (error) {
                console.error("打开本地预览失败:", error);
                wx.showToast({
                  title: "预览失败",
                  icon: "none",
                  duration: 2000,
                });
              }
            }
          },
        });
      } else if (successList.length > 0) {
        // 部分成功
        const content =
          "✓ " + successList.join("\n✓ ") + "\n\n✗ " + failList.join("\n✗ ");
        wx.showModal({
          title: "部分保存成功",
          content: content + "\n\n是否进行本地预览数据？",
          showCancel: true,
          cancelText: "否",
          confirmText: "是",
          success: async (res) => {
            if (res.confirm) {
              try {
                await FileExporter.exportToCsv(
                  this.lastResult!,
                  firstLoopResult,
                );
              } catch (error) {
                console.error("打开本地预览失败:", error);
                wx.showToast({
                  title: "预览失败",
                  icon: "none",
                  duration: 2000,
                });
              }
            }
          },
        });
      } else {
        // 全部失败
        const content = "✗ " + failList.join("\n✗ ");
        wx.showModal({
          title: "保存失败",
          content: content + "\n\n是否进行本地预览数据？",
          showCancel: true,
          cancelText: "否",
          confirmText: "是",
          success: async (res) => {
            if (res.confirm) {
              try {
                await FileExporter.exportToCsv(
                  this.lastResult!,
                  firstLoopResult,
                );
              } catch (error) {
                console.error("打开本地预览失败:", error);
                wx.showToast({
                  title: "预览失败",
                  icon: "none",
                  duration: 2000,
                });
              }
            }
          },
        });
      }
    } catch (error: any) {
      wx.hideLoading();
      console.error("保存数据失败:", error);
      wx.showToast({
        title: "保存失败，请重试",
        icon: "none",
        duration: 2000,
      });
    }
  },

  /** 刷新趋势图*/
  async refreshTrendCharts(bodyPart?: string, action?: string) {
    try {
      // 刷新趋势折线图
      await Promise.all([
        this.historyPainter?.setFilter(bodyPart, action),
        this.romHistoryPainter?.setFilter(bodyPart, action),
      ]);

      // 刷新趋势对比数据
      if (bodyPart && action) {
        const [historyDiff, romTrend] = await Promise.all([
          FeatureNoteManager.getTrendComparison(bodyPart, action),
          FeatureNoteManager.getRomTrendComparison(bodyPart, action),
        ]);
        this.setData({ historyDiff, romTrend });
      }
    } catch (error) {
      console.error("刷新趋势图失败:", error);
    }
  },

  /** 1. 短按归零：仅重置基准线 */
  onTapReset() {
    // 冗余检查：防止 disabled 属性失效时的误操作
    if (this.data.isBtnDisabled) return;

    // 执行基准校准流
    // this.engine?.startFlow(this._generateLabel());
    wx.showToast({ title: "请长按进行归零", icon: "none" });
  } /** 2. 长按归零：清空所有曲线和数据展示区 */,
  onLongPressReset() {
    if (this.data.isBtnDisabled) return;

    // 弹出确认对话框
    wx.showModal({
      title: "确认清零",
      content: "是否确认清零？",
      success: (res) => {
        if (res.confirm) {
          // 用户点击"是"，执行清零操作
          this._performReset();
        }
        // 用户点击"否"，不做任何操作
      },
    });
  },

  /** 执行实际的清零操作 */
  _performReset() {
    // A. 震动反馈
    wx.vibrateShort({ type: "medium" });

    // B. 引擎重置
    this.engine?.fullReset();

    // C. 清空最后一次测量结果
    this.lastResult = null;

    // D. UI 数据清空 (数据展示区归零)
    this.setData({
      "display.peak": 0,
      "display.angleMax": 0,
      "display.rfd": 0,
      "display.duration": 0,
      "display.activity": 0,
      "display.angleDiff": "0",
      "display.percentDiff": "0",
      statusText: "待机",
      //romTrend: { percent: "0%", isIncrease: true },
    });

    wx.showToast({ title: "数据已清空", icon: "success" });
  },

  /**最近测量趋势卡片中的点击事件 */
  onHistoryTouch(e: any) {
    this.historyPainter?.onTouch(e);
  },
  /**ROM实时曲线的触摸事件 */
  onRomTouchStart(e: any) {
    this.romRealtimePainter?.onTouchStart(e);
  },
  onRomTouchMove(e: any) {
    this.romRealtimePainter?.onTouchMove(e);
  },
  onRomTouchEnd() {
    this.romRealtimePainter?.onTouchEnd();
  },
  /**ROM最近测量趋势卡片中的点击事件 */
  onROMHistoryTouch(e: any) {
    this.romHistoryPainter?.onTouch(e);
  },

  /** 打开全屏RT曲线 */
  onOpenFullscreen() {
    this.setData({ showFullscreen: true });
    // 延迟初始化全屏Canvas，等待DOM渲染完成
    // 每次打开都重新创建，确保Canvas有效
    setTimeout(() => {
      this.fullscreenPainter = new FullscreenMMTPainter(
        "fullscreenCanvas",
        this,
      );
    }, 100);
  },

  /** 关闭全屏RT曲线 */
  onCloseFullscreen() {
    this.setData({ showFullscreen: false });
    // 销毁Painter，停止渲染循环
    this.fullscreenPainter = null;
  },

  /** 阻止触摸穿透 */
  preventTouchMove() {},

  /** 全屏Canvas触摸事件 */
  onFullscreenTouchStart(e: any) {
    this.fullscreenPainter?.onTouchStart(e);
  },

  onFullscreenTouchMove(e: any) {
    this.fullscreenPainter?.onTouchMove(e);
  },

  onFullscreenTouchEnd() {
    this.fullscreenPainter?.onTouchEnd();
  },

  /** 打开ROM全屏RT曲线 */
  onOpenROMFullscreen() {
    this.setData({ showROMFullscreen: true });
    // 延迟初始化全屏Canvas，等待DOM渲染完成
    // 每次打开都重新创建，确保Canvas有效
    setTimeout(() => {
      this.fullscreenROMPainter = new FullscreenROMPainter(
        "fullscreenROMCanvas",
        this,
      );
    }, 100);
  },

  /** 关闭ROM全屏RT曲线 */
  onCloseROMFullscreen() {
    this.setData({ showROMFullscreen: false });
    // 销毁Painter，停止渲染循环
    this.fullscreenROMPainter = null;
  },

  /** ROM全屏Canvas触摸事件 */
  onFullscreenROMTouchStart(e: any) {
    this.fullscreenROMPainter?.onTouchStart(e);
  },

  onFullscreenROMTouchMove(e: any) {
    this.fullscreenROMPainter?.onTouchMove(e);
  },

  onFullscreenROMTouchEnd() {
    this.fullscreenROMPainter?.onTouchEnd();
  },

  /** 打开最近测试趋势全屏 */
  onOpenHistoryFullscreen() {
    // 构建标签
    const side = this.data.sideIndex === 0 ? "左" : "右";
    const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
    const action = this.data.rotationOptions[this.data.rotationIndex];
    const label = `${side}—${bodyPart}—${action}`;
    this.setData({
      showHistoryFullscreen: true,
      historyFullscreenLabel: label,
    });
    setTimeout(() => {
      this.fullscreenHistoryPainter = new FullscreenHistoryPainter(
        "fullscreenHistoryCanvas",
        this,
      );
      // 设置筛选条件
      this.fullscreenHistoryPainter?.setFilter(bodyPart, action, side);
    }, 100);
  },

  /** 关闭最近测试趋势全屏 */
  onCloseHistoryFullscreen() {
    this.setData({ showHistoryFullscreen: false });
    this.fullscreenHistoryPainter = null;
  },

  /** 最近测试趋势全屏Canvas触摸事件 */
  onFullscreenHistoryTouch(e: any) {
    this.fullscreenHistoryPainter?.onTouch(e);
  },

  /** 打开ROM趋势全屏 */
  onOpenROMHistoryFullscreen() {
    // 构建标签
    const side = this.data.sideIndex === 0 ? "左" : "右";
    const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
    const action = this.data.rotationOptions[this.data.rotationIndex];
    const label = `${side}—${bodyPart}—${action}`;
    this.setData({
      showROMHistoryFullscreen: true,
      romHistoryFullscreenLabel: label,
    });
    setTimeout(() => {
      this.fullscreenROMHistoryPainter = new FullscreenROMHistoryPainter(
        "fullscreenROMHistoryCanvas",
        this,
      );
      // 设置筛选条件
      this.fullscreenROMHistoryPainter?.setFilter(bodyPart, action, side);
    }, 100);
  },

  /** 关闭ROM趋势全屏 */
  onCloseROMHistoryFullscreen() {
    this.setData({ showROMHistoryFullscreen: false });
    this.fullscreenROMHistoryPainter = null;
  },

  /** ROM趋势全屏Canvas触摸事件 */
  onFullscreenROMHistoryTouch(e: any) {
    this.fullscreenROMHistoryPainter?.onTouch(e);
  },

  /** 检查网络状态 */
  checkNetworkStatus() {
    wx.getNetworkType({
      success: (res) => {
        const isConnected = res.networkType !== "none";
        this.setData({
          isNetworkConnected: isConnected,
        });
      },
      fail: () => {
        // 获取失败时默认认为有网络
        this.setData({
          isNetworkConnected: true,
        });
      },
    });
  },

  /** 重新加载 */
  onRetryNetwork() {
    wx.showLoading({ title: "正在检查网络...", mask: true });
    this.checkNetworkStatus();
    setTimeout(() => {
      wx.hideLoading();
      if (!this.data.isNetworkConnected) {
        wx.showToast({
          title: "网络仍不可用",
          icon: "none",
          duration: 2000,
        });
      } else {
        wx.showToast({
          title: "网络已恢复",
          icon: "success",
          duration: 1500,
        });
        // 网络恢复后重新初始化所有Canvas
        setTimeout(() => {
          this.reinitAllCanvases();
          const bodyPart = this.data.bodyPartOptions[this.data.bodyPartIndex];
          const action = this.data.rotationOptions[this.data.rotationIndex];
          this.refreshTrendCharts(bodyPart, action);
        }, 100);
      }
    }, 1000);
  },

  /** 重新初始化所有Canvas */
  reinitAllCanvases() {
    console.log("重新初始化所有Canvas...");
    // 重新初始化主Canvas
    this.painter = new MMTPainter("forceCanvas", this);
    // 重新初始化历史趋势Canvas
    this.historyPainter = new HistoryPainter("historyCanvas", this);
    // 重新初始化ROM实时Canvas
    this.romRealtimePainter = new ROMRealtimePainter("romRealtimeCanvas", this);
    // 重新初始化ROM历史Canvas
    this.romHistoryPainter = new ROMHistoryPainter("romHistoryCanvas", this);
  },
});
