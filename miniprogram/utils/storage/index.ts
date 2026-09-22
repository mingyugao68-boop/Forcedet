// miniprogram/utils/storage/index.ts
import { BaseStorage } from "./BaseStorage";

export * from "./FileExporter";
export * from "./BaseStorage";
export * from "./CloudStorage";
export * from "./FeatureNoteManager";

// 导出 MMT 专用的存储实例
export const MMTStorage = new BaseStorage("MMT_STG_KEY");

// 导出 ROM 专用的存储实例
export const ROMStorage = new BaseStorage("ROM_STG_KEY");

//保存上次连接的设备MAC地址
const LAST_DEVICE_KEY = "LAST_CONNECTED_DEVICE_ID";
export const saveLastDeviceId = (id: string) =>
  wx.setStorageSync(LAST_DEVICE_KEY, id);
export const getLastDeviceId = (): string =>
  wx.getStorageSync(LAST_DEVICE_KEY) || "";
