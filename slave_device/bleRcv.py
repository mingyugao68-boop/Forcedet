#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ESP32-S3 力计 BLE 数据接收程序
蓝牙数据接收程序 - 解析力值和角度数据

使用方法:
    python bleRcv.py

依赖安装:
    pip install bleak
"""

import asyncio
import struct
import sys
from datetime import datetime
from typing import Optional, List, Dict, Any

# 尝试导入 bleak 库
try:
    from bleak import BleakClient, BleakScanner
    from bleak.backends.characteristic import BleakGATTCharacteristic
except ImportError:
    print("错误: 未找到 bleak 库。")
    print("请使用以下命令安装: pip install bleak")
    sys.exit(1)


# ============================================================================
# BLE UUID 配置 (来自 ESP32-S3.ino)
# ============================================================================
BLE_SERVICE_UUID = "5e8d4b2a-7b01-4b77-a9fe-7bbd140bdf76"      # 服务UUID
BLE_CHAR_UUID = "b4f36734-527d-4c6b-9cd9-5cfa1a260c60"        # 数据流特征UUID
BLE_CTRL_CHAR_UUID = "cf9fb4ac-858f-44b1-a0d5-b8f7bfcfdf13"   # 控制特征UUID

# 帧格式常量
FRAME_MAGIC = ord('D')  # 帧标识字节 0x44
FRAME_VERSION = 1       # 帧格式版本号
HEADER_LEN = 16         # 帧头长度（字节）
SAMPLE_LEN = 6          # 每个样本长度（字节）
MAX_SAMPLES = 10        # 每帧最大样本数


# ============================================================================
# 数据帧解析器
# ============================================================================
class BleFrameParser:
    """BLE数据帧解析器"""

    def __init__(self):
        """初始化解析器"""
        self.total_frames = 0      # 总帧数
        self.total_samples = 0     # 总样本数
        self.total_dropped = 0     # 总丢弃样本数
        self.last_seq = None       # 上一帧序列号
        self.seq_errors = 0        # 序列号错误计数

    def parse(self, data: bytes) -> Optional[Dict[str, Any]]:
        """
        解析BLE数据帧

        帧结构 (16字节帧头 + N * 6字节样本数据):
        - 字节 0:     帧标识 'D' (0x44)
        - 字节 1:     版本号 (1)
        - 字节 2-3:   序列号 (uint16, 小端序)
        - 字节 4-7:   时间戳T0，单位毫秒 (uint32, 小端序)
        - 字节 8-9:   时间间隔dt，单位微秒 (uint16, 小端序)
        - 字节 10:    样本数量 (1-10)
        - 字节 11:    标志位 (0x01 = 包含角度数据)
        - 字节 12-15: 丢弃样本计数 (uint32, 小端序)
        - 字节 16+:   样本数据 (力值: int32, 角度: int16)

        参数:
            data: 接收到的原始字节数据

        返回:
            解析成功返回包含帧数据的字典，失败返回 None
        """
        # 检查数据长度
        if len(data) < HEADER_LEN:
            print(f"[警告] 帧长度不足: {len(data)} 字节")
            return None

        # 检查帧标识字节
        if data[0] != FRAME_MAGIC:
            print(f"[警告] 无效的帧标识: 0x{data[0]:02X}, 期望 0x{FRAME_MAGIC:02X}")
            return None

        # 解析帧头
        version = data[1]
        if version != FRAME_VERSION:
            print(f"[警告] 不支持的帧版本: {version}")
            return None

        # 解析各字段（小端序）
        seq = struct.unpack('<H', data[2:4])[0]        # 序列号
        t0_ms = struct.unpack('<I', data[4:8])[0]      # 时间戳T0
        dt_us = struct.unpack('<H', data[8:10])[0]     # 时间间隔dt
        count = data[10]                                # 样本数量
        flags = data[11]                                # 标志位
        dropped = struct.unpack('<I', data[12:16])[0]  # 丢弃计数

        # 验证样本数量
        if count == 0 or count > MAX_SAMPLES:
            print(f"[警告] 无效的样本数量: {count}")
            return None

        # 检查数据长度是否匹配
        expected_len = HEADER_LEN + count * SAMPLE_LEN
        if len(data) < expected_len:
            print(f"[警告] 数据长度不匹配: 实际 {len(data)}, 期望 {expected_len}")
            return None

        # 检查序列号连续性
        if self.last_seq is not None:
            expected_seq = (self.last_seq + 1) & 0xFFFF
            if seq != expected_seq:
                self.seq_errors += 1
                print(f"[警告] 序列号跳变: 期望 {expected_seq}, 实际 {seq}")
        self.last_seq = seq

        # 解析样本数据
        samples = []
        offset = HEADER_LEN
        has_angle = (flags & 0x01) != 0  # 检查是否包含角度数据

        for i in range(count):
            # 解析力值原始数据 (int32, 小端序)
            force_raw = struct.unpack('<i', data[offset:offset+4])[0]
            # 解析角度值 (int16, 小端序)，单位为0.01度
            angle_deg_x100 = struct.unpack('<h', data[offset+4:offset+6])[0]
            # 转换为角度（度）
            angle_deg = angle_deg_x100 / 100.0

            samples.append({
                'index': i,                    # 样本序号
                'force_raw': force_raw,        # 力值原始数据
                'angle_deg_x100': angle_deg_x100,  # 角度值（×100）
                'angle_deg': angle_deg         # 角度值（度）
            })
            offset += SAMPLE_LEN

        # 更新统计信息
        self.total_frames += 1
        self.total_samples += count
        self.total_dropped += dropped

        return {
            'version': version,      # 版本号
            'seq': seq,              # 序列号
            't0_ms': t0_ms,          # 时间戳T0
            'dt_us': dt_us,          # 时间间隔dt
            'count': count,          # 样本数量
            'flags': flags,          # 标志位
            'has_angle': has_angle,  # 是否包含角度
            'dropped': dropped,      # 丢弃计数
            'samples': samples       # 样本列表
        }


# ============================================================================
# BLE 客户端处理器
# ============================================================================
class ForceMeterBleClient:
    """力计BLE客户端"""

    def __init__(self, debug: bool = False):
        """
        初始化BLE客户端

        参数:
            debug: 是否启用调试模式
        """
        self.debug = debug
        self.parser = BleFrameParser()
        self.client: Optional[BleakClient] = None
        self.running = False
        self._last_print_time = 0

    def notification_handler(self, characteristic: BleakGATTCharacteristic, data: bytearray):
        """
        BLE通知回调函数

        当收到BLE通知数据时被调用

        参数:
            characteristic: 触发通知的特征
            data: 接收到的数据
        """
        frame = self.parser.parse(bytes(data))
        if frame is None:
            return

        # 打印帧信息
        self._print_frame(frame)

    def _print_frame(self, frame: Dict[str, Any]):
        """
        打印帧数据

        参数:
            frame: 解析后的帧数据字典
        """
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        # 打印帧头信息
        print(f"\n[{timestamp}] 帧 #{frame['seq']:5d} | "
              f"样本数: {frame['count']} | "
              f"T0: {frame['t0_ms']}ms | "
              f"dt: {frame['dt_us']}us | "
              f"丢弃: {frame['dropped']}")

        # 打印样本数据表头
        print("-" * 70)
        print(f"{'序号':>4} | {'力值原始数据':>12} | {'角度 (度)':>12}")
        print("-" * 70)

        # 打印每个样本数据
        for sample in frame['samples']:
            print(f"{sample['index']:4d} | {sample['force_raw']:12d} | {sample['angle_deg']:12.2f}")

        # 每50帧打印一次统计信息
        if self.parser.total_frames % 50 == 0:
            self._print_stats()

    def _print_stats(self):
        """打印统计信息"""
        print("\n" + "=" * 70)
        print("统计信息")
        print("=" * 70)
        print(f"  总帧数:       {self.parser.total_frames}")
        print(f"  总样本数:     {self.parser.total_samples}")
        print(f"  总丢弃样本:   {self.parser.total_dropped}")
        print(f"  序列号错误:   {self.parser.seq_errors}")
        if self.parser.total_frames > 0:
            avg_samples = self.parser.total_samples / self.parser.total_frames
            print(f"  平均样本/帧:  {avg_samples:.2f}")
        print("=" * 70)

    async def scan_device(self, timeout: float = 10.0) -> Optional[str]:
        """
        扫描BLE设备

        参数:
            timeout: 扫描超时时间（秒）

        返回:
            找到的设备地址，未找到返回 None
        """
        print(f"\n正在扫描BLE设备 (超时: {timeout}秒)...")
        print(f"目标服务UUID: {BLE_SERVICE_UUID}")
        print("-" * 50)

        # 首先尝试通过服务UUID查找设备
        device = await BleakScanner.find_device_by_filter(
            lambda d, ad: any(
                uuid.lower() == BLE_SERVICE_UUID.lower()
                for uuid in ad.service_uuids
            ) if ad.service_uuids else False,
            timeout=timeout
        )

        if device:
            print(f"找到设备: {device.name or '未知'}")
            print(f"  地址: {device.address}")
            return device.address

        # 如果通过服务UUID未找到，尝试通过设备名称查找
        print("\n未通过服务UUID找到设备，正在扫描所有设备...")
        devices = await BleakScanner.discover(timeout=timeout)

        for d in devices:
            if d.name and "ESP32" in d.name:
                print(f"找到可能的设备: {d.name}")
                print(f"  地址: {d.address}")
                return d.address

        print("未找到匹配的设备。")
        return None

    async def connect_and_run(self, device_address: Optional[str] = None):
        """
        连接设备并开始接收数据

        参数:
            device_address: 设备蓝牙地址，为None时自动扫描
        """
        # 如果未提供地址，则扫描设备
        if device_address is None:
            device_address = await self.scan_device()
            if device_address is None:
                print("未能找到设备，程序退出。")
                return

        print(f"\n正在连接 {device_address}...")

        async with BleakClient(device_address) as client:
            self.client = client
            self.running = True

            # 打印连接信息
            print(f"已连接: {client.is_connected}")
            print(f"设备: {client.address}")

            # 列出所有服务
            print("\n服务列表:")
            for service in client.services:
                print(f"  服务: {service.uuid}")
                for char in service.characteristics:
                    props = ", ".join(char.properties)
                    print(f"    特征: {char.uuid} [{props}]")

            # 检查目标特征是否存在
            if BLE_CHAR_UUID.lower() not in [c.uuid.lower() for c in client.services.characteristics.values()]:
                print(f"\n错误: 未找到目标特征 {BLE_CHAR_UUID}!")
                return

            print(f"\n正在订阅特征: {BLE_CHAR_UUID}")

            # 订阅通知
            await client.start_notify(BLE_CHAR_UUID, self.notification_handler)

            print("\n" + "=" * 70)
            print("正在接收数据... 按 Ctrl+C 停止。")
            print("=" * 70)

            # 持续运行直到被中断
            try:
                while self.running and client.is_connected:
                    await asyncio.sleep(0.1)
            except asyncio.CancelledError:
                pass
            finally:
                print("\n正在停止通知...")
                await client.stop_notify(BLE_CHAR_UUID)
                self._print_stats()

    def stop(self):
        """停止运行"""
        self.running = False


# ============================================================================
# 主程序入口
# ============================================================================
async def main():
    """主函数"""
    import argparse

    # 创建命令行参数解析器
    parser = argparse.ArgumentParser(
        description="ESP32-S3 力计 BLE 数据接收程序",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
    python bleRcv.py                        # 自动扫描并连接
    python bleRcv.py -a XX:XX:XX:XX:XX:XX   # 连接指定地址的设备
    python bleRcv.py --scan                 # 仅扫描设备，不连接
"""
    )
    parser.add_argument(
        '-a', '--address',
        type=str,
        default=None,
        help='BLE设备地址 (MAC地址)'
    )
    parser.add_argument(
        '--scan',
        action='store_true',
        help='仅扫描设备，不连接'
    )
    parser.add_argument(
        '-d', '--debug',
        action='store_true',
        help='启用调试输出'
    )
    parser.add_argument(
        '-t', '--timeout',
        type=float,
        default=10.0,
        help='扫描超时时间，单位秒 (默认: 10)'
    )

    args = parser.parse_args()

    # 打印程序横幅
    print("=" * 70)
    print("ESP32-S3 力计 - BLE 数据接收程序")
    print("=" * 70)
    print(f"服务UUID:    {BLE_SERVICE_UUID}")
    print(f"数据流UUID:  {BLE_CHAR_UUID}")
    print(f"控制UUID:    {BLE_CTRL_CHAR_UUID}")
    print("=" * 70)

    # 创建客户端实例
    client = ForceMeterBleClient(debug=args.debug)

    try:
        if args.scan:
            # 仅扫描模式
            await client.scan_device(timeout=args.timeout)
        else:
            # 连接并接收数据
            await client.connect_and_run(device_address=args.address)
    except KeyboardInterrupt:
        print("\n\n用户中断。")
        client.stop()
    except Exception as e:
        print(f"\n错误: {e}")
        if args.debug:
            import traceback
            traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
