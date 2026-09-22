/**
 * ESP32-S3 Force + IMU 流式传输系统
 * ─────────────────────────────────────────────────────────────────────────────
 * 新增特性（相对原始 ESP32-S3.ino）：
 *   1. BLE 服务 UUID 由设备蓝牙 MAC 地址经 SHA-1 自动生成（UUID v5，RFC 4122），
 *      每台设备唯一且可复现，无需手动分配。
 *   2. 力传感器标定框架：新增两点标定参数与换算注释，首次标定后填入即可。
 *   3. tare() 样本数 8 → 320（320SPS 下约 1 秒均值），大幅降低零偏误差。
 *   4. NAU7802 AFE 校准后增加 500 ms 稳定等待，避免读取噪声偏大的初始样本。
 *   5. ForceSnapshot.cn 修复：原为 cn = raw（无意义），现为 cn = (int32_t)filt
 *      （EMA 滤波后的计数值），并在 DEBUG_LOG 下打印克换算结果。
 *   6. 移除孤立的前向声明 bleSendTask（文件中无对应实现）。
 *
 * Arduino IDE 额外依赖（在原依赖基础上新增）：
 *   - mbedtls（ESP32 Arduino Core 自带，无需额外安装）
 *   - esp_mac.h（ESP32 Arduino Core 自带）
 * ─────────────────────────────────────────────────────────────────────────────
 */

#include <Wire.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <AsyncWebSocket.h>
#include <BLEDevice.h>
#include <BLE2902.h>
#include <Adafruit_NAU7802.h>
#include <limits.h>
#include <math.h>
#include <type_traits>
#include <utility>
// ── [新增] UUID v5 生成所需头文件 ───────────────────────────────────────────
#include "mbedtls/sha1.h"
#include <esp_system.h>
#include <esp_mac.h>

// ═══════════════════════════════════════════════════════════════════════════
// I2C 配置
// ═══════════════════════════════════════════════════════════════════════════
constexpr int I2C_SDA = 1;            // I2C 数据线 GPIO (SDA)
constexpr int I2C_SCL = 2;            // I2C 时钟线 GPIO (SCL)
constexpr uint32_t I2C_FREQ = 400000; // I2C 时钟频率，单位 Hz（400 kHz 快速模式）

constexpr int TARE_BTN_PIN = 0; // Active-low tare button (BOOT)

#ifndef ENABLE_SERIAL
#define ENABLE_SERIAL 1
#endif

#ifndef ENABLE_WIFI_AP
#define ENABLE_WIFI_AP 0
#endif

#ifndef ENABLE_WS
#define ENABLE_WS 0
#endif

#ifndef ENABLE_BLE
#define ENABLE_BLE 1
#endif

#ifndef DEBUG_LOG
#define DEBUG_LOG 1
#endif

#ifndef PLOT_MODE
#define PLOT_MODE 0
#endif

#ifndef RAW_DEBUG_INTERVAL_MS
#define RAW_DEBUG_INTERVAL_MS 500
#endif

#ifndef DIAG_STATUS_INTERVAL_MS
#define DIAG_STATUS_INTERVAL_MS 2000
#endif

#ifndef SEND_HZ_WS
#define SEND_HZ_WS 25
#endif

#ifndef SEND_HZ_BLE
#define SEND_HZ_BLE 10
#endif

#if DEBUG_LOG
#define DEBUG_PRINTF(...) Serial.printf(__VA_ARGS__)
#define DEBUG_PRINTLN(...) Serial.println(__VA_ARGS__)
#define DEBUG_PRINT(...) Serial.print(__VA_ARGS__)
#else
#define DEBUG_PRINTF(...)
#define DEBUG_PRINTLN(...)
#define DEBUG_PRINT(...)
#endif

// ═══════════════════════════════════════════════════════════════════════════
// 传感器与算法配置
// ═══════════════════════════════════════════════════════════════════════════
constexpr int OVERSAMPLE = 1;          // Samples per reading (set to 1 for raw RFD)
constexpr float DISPLAY_ALPHA = 0.15f; // EMA 平滑系数（仅用于展示，不影响 BLE 流）

// ── ADC 软件抽取（decimation）配置 ────────────────────────────────────────
//   DECIM_N = 1 → 不抽取
//   DECIM_N = 2 → 有效 ~160Hz 输出
//   DECIM_N = 4 → 有效 ~80Hz  输出

constexpr int DECIM_N = 2; // ← 改这一个数字即可调整有效采样率

// IMU 校准开关
constexpr bool USE_ACCEL_OFFSET_CAL = false;
constexpr bool USE_GYRO_OFFSET_CAL = false;

// ── [新增] 力传感器两点标定参数 ─────────────────────────────────────────────
//
// 标定流程（只需做一次，结果写死在此处）：
//   Step 1: 空载，上电后等 tare() 完成（串口打印 "Tare done"）。
//   Step 2: 放上已知重量 W 克的砝码，静置约 2 秒。
//   Step 3: 打开串口监视器，记录打印的 raw 均值（DEBUG_LOG=1 时可见）。
//           或：将下方 SCALE_CAL_MODE 改为 1，上电后串口自动打印 10 秒均值。
//   Step 4: SCALE_SENSITIVITY = (Step3 的 raw 均值) / W
//   Step 5: 将算出的值填入 SCALE_SENSITIVITY，重新烧录。
//
// 未标定时保持 SCALE_SENSITIVITY = 0.0f，此时 force 字段输出原始 ADC 计数值。
//
constexpr float SCALE_SENSITIVITY = 21.502f; // 单位: counts/g；0 = 未标定  2859.83/133g = 21.502f

// ── [新增] UUID v5 命名空间（DNS namespace，RFC 4122 附录 C）───────────────
// 可按需替换为自定义 16 字节命名空间。
static const uint8_t UUID_NAMESPACE[16] = {
    0x7b, 0xa7, 0xb8, 0x10,
    0x9d, 0xad,
    0x11, 0xd1,
    0x80, 0xb4,
    0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8};

// ── [新增] 设备唯一标识全局变量 ─────────────────────────────────────────────
char g_uuidStr[37]; // "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\0"，由 MAC 生成
char g_macStr[18];  // "XX:XX:XX:XX:XX:XX\0"

// WiFi AP + WebSocket 配置
const char *WIFI_AP_SSID = "ESP32-forcedet";
const char *WIFI_AP_PASS = "12345678";
const IPAddress WIFI_AP_IP(192, 168, 4, 1);
const IPAddress WIFI_AP_GATEWAY(192, 168, 4, 1);
const IPAddress WIFI_AP_SUBNET(255, 255, 255, 0);

constexpr uint32_t WS_SEND_INTERVAL_MS = 1000UL / SEND_HZ_WS;
// BLE: 即时发送模式，带频率限制（最高 200 Hz）
constexpr uint32_t BLE_MIN_INTERVAL_US = 5000; // 5ms = 200Hz max
const char CSV_HEADER[] = "ts_ms,force_raw,angle_deg_x100";

// ═══════════════════════════════════════════════════════════════════════════
// QMI8658A IMU 寄存器与灵敏度配置
// ═══════════════════════════════════════════════════════════════════════════
constexpr uint8_t QMI8658_ADDR = 0x6A;
constexpr uint8_t QMI8658_REG_WHOAMI = 0x00;
constexpr uint8_t QMI8658_REG_CTRL1 = 0x02;
constexpr uint8_t QMI8658_REG_CTRL2 = 0x03;
constexpr uint8_t QMI8658_REG_CTRL3 = 0x04;
constexpr uint8_t QMI8658_REG_CTRL4 = 0x05;
constexpr uint8_t QMI8658_REG_CTRL5 = 0x06;
constexpr uint8_t QMI8658_REG_CTRL6 = 0x07;
constexpr uint8_t QMI8658_REG_CTRL7 = 0x08;
constexpr uint8_t QMI8658_REG_ACCEL_X_L = 0x35;
constexpr uint8_t QMI8658_REG_GYRO_X_L = 0x3B;

constexpr float ACCEL_LSB_PER_G = 8192.0f; // ±4 g，16-bit
constexpr float GYRO_LSB_PER_DPS = 16.0f;  // ±2048 dps，16-bit
constexpr uint32_t SERIAL_BAUD = 921600;

// ═══════════════════════════════════════════════════════════════════════════
// 数据结构
// ═══════════════════════════════════════════════════════════════════════════
struct SampleRecord
{
  uint32_t tsMs;
  int32_t force; // BLE/串口输出的力值（原始 ADC 计数，tare 后）
  int16_t angleDegX100;
};

struct ForceSnapshot
{
  uint32_t tsUs;
  int32_t raw; // 原始 ADC 计数（tare 后），用于高速 BLE 动态流
  int32_t cn;  // [修复] EMA 滤波后的计数值（原为 cn=raw，现为 cn=(int32_t)filt）
};

struct ImuSnapshot
{
  uint32_t imu_ts_us;
  uint32_t imu_seq;
  int32_t axCal, ayCal, azCal;
  int32_t gxCal, gyCal, gzCal;
  int16_t relRollDegX100;
  int16_t relPitchDegX100;
  int16_t tiltDegX100;
};

struct Quaternion
{
  float w, x, y, z;
};

enum AngleChannel : uint8_t
{
  ANGLE_CHANNEL_ROLL = 0,
  ANGLE_CHANNEL_PITCH = 1,
  ANGLE_CHANNEL_TILT = 2,
};

// ═══════════════════════════════════════════════════════════════════════════
// 全局对象与状态变量
// ═══════════════════════════════════════════════════════════════════════════
TwoWire i2cBus(0);
Adafruit_NAU7802 nau;
AsyncWebServer webServer(80);
AsyncWebSocket ws("/ws");

int32_t zeroOffset = 0; // tare 零偏（raw counts）
bool qmiReady = false;
volatile bool requestTare = false;
uint32_t lastStatsMs = 0;
uint32_t sampleCountInWindow = 0;
uint32_t imuCountInWindow = 0;
uint32_t sendCountInWindow = 0;
uint32_t forceDropCountInWindow = 0;
uint32_t lastSampleTsUs = 0;
uint32_t minSampleIntervalUs = UINT32_MAX;
uint32_t maxSampleIntervalUs = 0;
uint64_t sumSampleIntervalUs = 0;
uint32_t sampleIntervalCount = 0;
int32_t accelOffsetX = 0, accelOffsetY = 0, accelOffsetZ = 0;
int16_t gyroOffsetX = 0, gyroOffsetY = 0, gyroOffsetZ = 0;
float accelBiasGX = 0.0f, accelBiasGY = 0.0f, accelBiasGZ = 0.0f;
float gyroBiasDpsX = 0.0f, gyroBiasDpsY = 0.0f, gyroBiasDpsZ = 0.0f;
ImuSnapshot latestImuSnapshot{};
uint32_t lastImuSeqPrinted = 0;
ForceSnapshot latestForceSnapshot{};
volatile int16_t latestAngleDegX100 = 0;
volatile AngleChannel angleChannel = ANGLE_CHANNEL_PITCH;
volatile uint32_t droppedSamplesCounter = 0;
uint32_t rawFrameCount = 0;
uint32_t rawValueChangeCount = 0;
uint32_t imuFrameCount = 0;
uint32_t bleNotifyAttemptCount = 0;
uint32_t bleNotifySentCount = 0;
uint32_t bleNotifySkippedNoCharCount = 0;
uint32_t bleNotifySkippedDisconnectedCount = 0;
int32_t lastRawObserved = 0;
bool rawEverUpdated = false;
bool imuEverUpdated = false;
bool bleEverSent = false;

Quaternion qCurrent{1.0f, 0.0f, 0.0f, 0.0f};
Quaternion qReference{1.0f, 0.0f, 0.0f, 0.0f};
float fusedRollRad = 0.0f;
float fusedPitchRad = 0.0f;

portMUX_TYPE sampleMux = portMUX_INITIALIZER_UNLOCKED;
SampleRecord latestSample{};
TaskHandle_t wsTaskHandle = nullptr;
BLECharacteristic *streamCharacteristic = nullptr;
BLECharacteristic *controlCharacteristic = nullptr;
volatile bool deviceConnected = false;
uint32_t wsSentCount = 0;
uint32_t wsDropCount = 0;
uint32_t lastBleSendUs = 0; // BLE 发送节流控制

// ── BLE UUID 配置 ──────────────────────────────────────────────────────────
// BLE_SERVICE_UUID 在 initDeviceUUID() 调用后指向 g_uuidStr（动态生成）。
// BLE_CHAR_UUID / BLE_CTRL_CHAR_UUID 固定，标识具体特征功能。
// [修改] 原为硬编码字符串，现在运行时指向由 MAC 生成的 UUID v5
const char *BLE_SERVICE_UUID = g_uuidStr;
const char *BLE_CHAR_UUID = "b4f36734-527d-4c6b-9cd9-5cfa1a260c60";
const char *BLE_CTRL_CHAR_UUID = "cf9fb4ac-858f-44b1-a0d5-b8f7bfcfdf13";

// ═══════════════════════════════════════════════════════════════════════════
// 函数前向声明
// ═══════════════════════════════════════════════════════════════════════════
// [新增] UUID v5
void generateUUIDv5(const uint8_t *ns, const uint8_t *name, size_t nameLen, uint8_t *out);
void uuidToString(const uint8_t *uuid, char *out);
void initDeviceUUID();

void tareBoot();               // 开机精准调零（320 样本，仅 setup 阶段使用）
void tare();                   // 交互式调零（80 样本，≈250ms，不长时间阻塞 loop）
void printCalibrationHelper(); // 串口打印标定辅助信息（DEBUG_LOG=1 时有效）
bool qmiWriteReg(uint8_t reg, uint8_t value);
bool qmiReadBytes(uint8_t reg, uint8_t *buf, size_t len);
bool qmiReadReg(uint8_t reg, uint8_t &value);
bool initQMI8658();
bool readQMI8658AccelGyro(int16_t &ax, int16_t &ay, int16_t &az, int16_t &gx, int16_t &gy, int16_t &gz);
void autoCalibrateOnBoot();
void dumpQMI();
void emitStats();
void printRawDebugLine(int32_t raw, int32_t filtCounts);
void printDiagStatus(const char *reason);
size_t buildCsvLine(const SampleRecord &s, char *out, size_t outLen);
void sendBleFrame(int32_t force, int16_t angleDegX100);
void printCsvLine(const SampleRecord &s);
void setupWiFiAp();
void setupHttpServer();
void setupBle();
void wsSendTask(void *param);
// [移除] bleSendTask 孤立前向声明（文件中无对应实现，BLE 在 loop() 中即时发送）
SampleRecord makeSnapshot(uint32_t tsUs);
bool websocketWritable();
void sendWsMeta(AsyncWebSocketClient *client);
void handleImuZeroCommand();
Quaternion quatMultiply(const Quaternion &a, const Quaternion &b);
Quaternion quatInverse(const Quaternion &q);
void quatNormalize(Quaternion &q);
Quaternion quatFromEuler(float roll, float pitch, float yaw);
void quatToEuler(const Quaternion &q, float &roll, float &pitch, float &yaw);
int16_t selectAngleByChannel(const ImuSnapshot &snap);
void printImuCurvesLine(const ImuSnapshot &snap);

// ═══════════════════════════════════════════════════════════════════════════
// 环形缓冲区
// ═══════════════════════════════════════════════════════════════════════════
constexpr size_t SAMPLE_RING_CAP = 2048;
SampleRecord sampleRing[SAMPLE_RING_CAP];
volatile size_t sampleHead = 0;
volatile size_t sampleTail = 0;

inline size_t ringCount()
{
  size_t h = sampleHead, t = sampleTail;
  return (h >= t) ? (h - t) : (SAMPLE_RING_CAP - (t - h));
}

inline bool ringPush(const SampleRecord &rec, bool &dropped)
{
  size_t nextHead = (sampleHead + 1) % SAMPLE_RING_CAP;
  dropped = false;
  if (nextHead == sampleTail)
  {
    sampleTail = (sampleTail + 1) % SAMPLE_RING_CAP;
    dropped = true;
    droppedSamplesCounter++;
  }
  sampleRing[sampleHead] = rec;
  sampleHead = nextHead;
  return true;
}

inline bool ringPop(SampleRecord &out)
{
  if (sampleHead == sampleTail)
    return false;
  out = sampleRing[sampleTail];
  sampleTail = (sampleTail + 1) % SAMPLE_RING_CAP;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 单位转换
// ═══════════════════════════════════════════════════════════════════════════
inline int32_t accelToMg(int32_t cal)
{
  return (int32_t)((static_cast<float>(cal) * 1000.0f) / ACCEL_LSB_PER_G);
}

inline int32_t gyroToMdps(int32_t cal)
{
  return (int32_t)((static_cast<float>(cal) * 1000.0f) / GYRO_LSB_PER_DPS);
}

// ── [新增] 力值单位换算（需先完成标定）────────────────────────────────────
// 当 SCALE_SENSITIVITY > 0 时将原始计数换算为克，否则返回原始计数。
inline float countsToGrams(int32_t counts)
{
  if (SCALE_SENSITIVITY > 0.0f)
    return (float)counts / SCALE_SENSITIVITY;
  return (float)counts; // 未标定，返回原始计数
}

// ═══════════════════════════════════════════════════════════════════════════
// [新增] UUID v5 生成函数
// ─────────────────────────────────────────────────────────────────────────
// 原理：SHA-1(命名空间 || MAC字符串)，取前 16 字节，
//       按 RFC 4122 设置 version=5 和 variant 位。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 根据命名空间 + 名称生成 UUID v5（16 字节输出）
 * @param ns      16 字节命名空间
 * @param name    名称字节数组（此处为 MAC 字符串）
 * @param nameLen 名称字节长度
 * @param out     16 字节输出缓冲
 */
void generateUUIDv5(const uint8_t *ns, const uint8_t *name, size_t nameLen, uint8_t *out)
{
  uint8_t hash[20];
  mbedtls_sha1_context ctx;
  mbedtls_sha1_init(&ctx);
  mbedtls_sha1_starts(&ctx);
  mbedtls_sha1_update(&ctx, ns, 16);
  mbedtls_sha1_update(&ctx, name, nameLen);
  mbedtls_sha1_finish(&ctx, hash);
  mbedtls_sha1_free(&ctx);

  memcpy(out, hash, 16);
  out[6] = (out[6] & 0x0F) | 0x50; // version = 5
  out[8] = (out[8] & 0x3F) | 0x80; // variant = 10xxxxxx
}

/**
 * 将 16 字节 UUID 转换为标准连字符字符串
 * "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
void uuidToString(const uint8_t *uuid, char *out)
{
  snprintf(out, 37,
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           uuid[0], uuid[1], uuid[2], uuid[3],
           uuid[4], uuid[5],
           uuid[6], uuid[7],
           uuid[8], uuid[9],
           uuid[10], uuid[11], uuid[12], uuid[13], uuid[14], uuid[15]);
}

/**
 * 读取蓝牙 MAC → 生成 UUID v5 → 写入 g_macStr / g_uuidStr。
 * 必须在 setupBle() 之前调用（BLE_SERVICE_UUID 指向 g_uuidStr）。
 */
void initDeviceUUID()
{
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(g_macStr, sizeof(g_macStr),
           "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

  uint8_t uuidBytes[16];
  generateUUIDv5(UUID_NAMESPACE, (const uint8_t *)g_macStr, strlen(g_macStr), uuidBytes);
  uuidToString(uuidBytes, g_uuidStr);

#if ENABLE_SERIAL || DEBUG_LOG
  Serial.println("\n=== 设备 UUID v5 初始化 ===");
  Serial.print("蓝牙 MAC  : ");
  Serial.println(g_macStr);
  Serial.print("服务 UUID : ");
  Serial.println(g_uuidStr);
  Serial.println("===========================\n");
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// BLE 帧发送（8 字节极简帧，loop() 中即时调用）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 极简 BLE 帧格式（8 字节）：
 *   Byte 0    : 帧头 'F' (0x46)
 *   Byte 1-4  : force (int32, 小端序, 单位: raw counts)
 *   Byte 5-6  : angle (int16, 小端序, 单位: 0.01°)
 *   Byte 7    : 校验和（前 7 字节异或）
 */
void sendBleFrame(int32_t force, int16_t angleDegX100)
{
  bleNotifyAttemptCount++;
  if (!streamCharacteristic)
  {
    bleNotifySkippedNoCharCount++;
    return;
  }
  if (!deviceConnected)
  {
    bleNotifySkippedDisconnectedCount++;
    return;
  }

  uint8_t frame[8];
  frame[0] = 'F';
  frame[1] = (uint8_t)(force & 0xFF);
  frame[2] = (uint8_t)((force >> 8) & 0xFF);
  frame[3] = (uint8_t)((force >> 16) & 0xFF);
  frame[4] = (uint8_t)((force >> 24) & 0xFF);
  frame[5] = (uint8_t)(angleDegX100 & 0xFF);
  frame[6] = (uint8_t)((angleDegX100 >> 8) & 0xFF);

  uint8_t checksum = 0;
  for (int i = 0; i < 7; i++)
    checksum ^= frame[i];
  frame[7] = checksum;

  streamCharacteristic->setValue(frame, 8);
  streamCharacteristic->notify();
  bleNotifySentCount++;
  bleEverSent = true;

  if (DEBUG_LOG && !PLOT_MODE)
  {
    if (bleNotifySentCount <= 5 || (bleNotifySentCount % 100) == 0)
    {
      DEBUG_PRINTF("[BLE-TX] sent=%lu force=%ld angle=%d checksum=0x%02X connected=%s\n",
                   (unsigned long)bleNotifySentCount,
                   (long)force,
                   (int)angleDegX100,
                   (unsigned int)checksum,
                   deviceConnected ? "true" : "false");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 快照与四元数工具函数
// ═══════════════════════════════════════════════════════════════════════════
SampleRecord makeSnapshot(uint32_t tsUs)
{
  ForceSnapshot forceSnap = latestForceSnapshot;
  SampleRecord rec{};
  rec.tsMs = tsUs ? (tsUs / 1000) : millis();
  rec.force = forceSnap.raw; // BLE 动态流使用原始计数（全带宽）
  rec.angleDegX100 = latestAngleDegX100;
  return rec;
}

Quaternion quatMultiply(const Quaternion &a, const Quaternion &b)
{
  return {
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w};
}

Quaternion quatInverse(const Quaternion &q)
{
  return {q.w, -q.x, -q.y, -q.z};
}

void quatNormalize(Quaternion &q)
{
  float n = sqrtf(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  if (n <= 0.0f)
  {
    q = {1.0f, 0.0f, 0.0f, 0.0f};
    return;
  }
  q.w /= n;
  q.x /= n;
  q.y /= n;
  q.z /= n;
}

Quaternion quatFromEuler(float roll, float pitch, float yaw)
{
  float cr = cosf(roll * 0.5f), sr = sinf(roll * 0.5f);
  float cp = cosf(pitch * 0.5f), sp = sinf(pitch * 0.5f);
  float cy = cosf(yaw * 0.5f), sy = sinf(yaw * 0.5f);
  Quaternion q{
      cr * cp * cy + sr * sp * sy,
      sr * cp * cy - cr * sp * sy,
      cr * sp * cy + sr * cp * sy,
      cr * cp * sy - sr * sp * cy};
  quatNormalize(q);
  return q;
}

void quatToEuler(const Quaternion &q, float &roll, float &pitch, float &yaw)
{
  float sinr = 2.0f * (q.w * q.x + q.y * q.z);
  float cosr = 1.0f - 2.0f * (q.x * q.x + q.y * q.y);
  roll = atan2f(sinr, cosr);

  float sinp = 2.0f * (q.w * q.y - q.z * q.x);
  pitch = (fabsf(sinp) >= 1.0f) ? copysignf(1.57079632679f, sinp) : asinf(sinp);

  float siny = 2.0f * (q.w * q.z + q.x * q.y);
  float cosy = 1.0f - 2.0f * (q.y * q.y + q.z * q.z);
  yaw = atan2f(siny, cosy);
}

void handleImuZeroCommand()
{
  qReference = qCurrent;
  if (DEBUG_LOG)
    DEBUG_PRINTLN("IMU_ZERO applied");
}

int16_t selectAngleByChannel(const ImuSnapshot &snap)
{
  switch (angleChannel)
  {
  case ANGLE_CHANNEL_ROLL:
    return snap.relRollDegX100;
  case ANGLE_CHANNEL_TILT:
    return snap.tiltDegX100;
  case ANGLE_CHANNEL_PITCH:
  default:
    return snap.relPitchDegX100;
  }
}

void printImuCurvesLine(const ImuSnapshot &snap)
{
#if ENABLE_SERIAL
  Serial.printf("%d,%d,%d\n",
                (int)snap.relRollDegX100,
                (int)snap.relPitchDegX100,
                (int)snap.tiltDegX100);
#else
  (void)snap;
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// NAU7802 力传感器：tare（调零）
// ─────────────────────────────────────────────────────────────────────────
// 分为两个版本：
//   tareBoot()   — 开机专用，320 个样本（@320SPS ≈ 1 秒），精度最高
//   tare()       — 交互式，80 个样本（@320SPS ≈ 250ms），避免长时间阻塞 loop()
//
// [修复] 原版本 tare() 使用 320 个样本，每次交互调零时 loop() 被阻塞约 1 秒，
//         导致 IMU 在此期间完全停止采样。现在交互版本仅采 80 个样本（≈ 250ms）。
// ═══════════════════════════════════════════════════════════════════════════

/** 内部通用采样实现 */
static void tareImpl(int numSamples)
{
  int64_t sum = 0;
  int valid = 0;
  for (int i = 0; i < numSamples; i++)
  {
    uint32_t t0 = millis();
    while (!nau.available())
    {
      if ((uint32_t)(millis() - t0) > 20)
        break; // 超时保护，防止硬件异常死等
      delay(1);
    }
    if (nau.available())
    {
      sum += nau.read();
      valid++;
    }
  }
  if (valid > 0)
    zeroOffset = (int32_t)(sum / valid);

  if (DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTF("Tare done: %d/%d samples, offset=%ld\n",
                 valid, numSamples, (long)zeroOffset);
}

/** 开机精准调零：320 个样本 ≈ 1 秒（仅在 setup() 阶段调用）*/
void tareBoot() { tareImpl(320); }

/** 交互式调零：80 个样本 ≈ 250ms（按钮/WebSocket 触发，不会长时间阻塞 loop）*/
void tare() { tareImpl(80); }

// ── [新增] 标定辅助：串口打印当前负载的计数值 ────────────────────────────────
// 用法：在 DEBUG_LOG=1 且放上已知重量砝码稳定后，观察串口输出的
//       "CAL: raw_avg=XXXXX  → 将此值除以砝码克数 = SCALE_SENSITIVITY"
// ─────────────────────────────────────────────────────────────────────────
void printCalibrationHelper()
{
#if DEBUG_LOG
  if (PLOT_MODE)
    return;
  const int CAL_SAMPLES = 160; // 0.5 秒均值
  int64_t sum = 0;
  int valid = 0;
  for (int i = 0; i < CAL_SAMPLES; i++)
  {
    uint32_t t0 = millis();
    while (!nau.available())
    {
      if ((uint32_t)(millis() - t0) > 20)
        break;
      delay(1);
    }
    if (nau.available())
    {
      sum += (int32_t)nau.read() - zeroOffset;
      valid++;
    }
  }
  if (valid > 0)
  {
    int32_t avg = (int32_t)(sum / valid);
    Serial.printf("[CAL] raw_avg=%ld counts  (0.5s mean, n=%d)\n", (long)avg, valid);
    if (SCALE_SENSITIVITY > 0.0f)
      Serial.printf("[CAL] → %.2f g  (with current SCALE_SENSITIVITY=%.2f)\n",
                    (float)avg / SCALE_SENSITIVITY, SCALE_SENSITIVITY);
    else
      Serial.printf("[CAL] → SCALE_SENSITIVITY=0, not calibrated. "
                    "Set SCALE_SENSITIVITY = %ld / <known_grams>\n",
                    (long)avg);
  }
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// QMI8658A IMU 驱动
// ═══════════════════════════════════════════════════════════════════════════
bool qmiWriteReg(uint8_t reg, uint8_t value)
{
  i2cBus.beginTransmission(QMI8658_ADDR);
  i2cBus.write(reg);
  i2cBus.write(value);
  return i2cBus.endTransmission() == 0;
}

bool qmiReadBytes(uint8_t reg, uint8_t *buf, size_t len)
{
  i2cBus.beginTransmission(QMI8658_ADDR);
  i2cBus.write(reg);
  if (i2cBus.endTransmission(false) != 0)
    return false;
  uint8_t readLen = i2cBus.requestFrom(QMI8658_ADDR, (uint8_t)len);
  if (readLen != len)
    return false;
  for (uint8_t i = 0; i < len; i++)
    buf[i] = i2cBus.read();
  return true;
}

bool qmiReadReg(uint8_t reg, uint8_t &value)
{
  uint8_t buf = 0;
  if (!qmiReadBytes(reg, &buf, 1))
    return false;
  value = buf;
  return true;
}

bool initQMI8658()
{
  uint8_t who = 0;
  if (!qmiReadBytes(QMI8658_REG_WHOAMI, &who, 1))
  {
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTLN("QMI8658 whoami read failed");
    return false;
  }
  if (DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTF("QMI8658 WHOAMI: 0x%02X\n", who);

  bool ok = true;
  ok &= qmiWriteReg(QMI8658_REG_CTRL7, 0x00);
  ok &= qmiWriteReg(QMI8658_REG_CTRL1, 0x60);
  ok &= qmiWriteReg(QMI8658_REG_CTRL2, 0x15); // accel: ±4g, ~200Hz
  ok &= qmiWriteReg(QMI8658_REG_CTRL3, 0x95); // gyro: ±2048dps, ~200Hz
  ok &= qmiWriteReg(QMI8658_REG_CTRL4, 0x11);
  ok &= qmiWriteReg(QMI8658_REG_CTRL5, 0x00);
  ok &= qmiWriteReg(QMI8658_REG_CTRL6, 0x00);
  ok &= qmiWriteReg(QMI8658_REG_CTRL7, 0x03);

  if (!ok)
  {
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTLN("QMI8658 config failed");
    return false;
  }

  delay(10);
  uint8_t gyroCtrl = 0;
  if (qmiReadReg(QMI8658_REG_CTRL3, gyroCtrl))
  {
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTF("QMI8658 gyro CTRL3 readback: 0x%02X\n", gyroCtrl);
  }
  else
  {
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTLN("QMI8658 gyro CTRL3 readback failed");
  }
  dumpQMI();
  return true;
}

void dumpQMI()
{
  uint8_t c1 = 0, c2 = 0, c3 = 0, c4 = 0, c7 = 0;
  bool ok = qmiReadReg(QMI8658_REG_CTRL1, c1);
  ok &= qmiReadReg(QMI8658_REG_CTRL2, c2);
  ok &= qmiReadReg(QMI8658_REG_CTRL3, c3);
  ok &= qmiReadReg(QMI8658_REG_CTRL4, c4);
  ok &= qmiReadReg(QMI8658_REG_CTRL7, c7);
  if (ok && DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTF("QMI8658 CTRL dump: CTRL1=0x%02X CTRL2=0x%02X CTRL3=0x%02X CTRL4=0x%02X CTRL7=0x%02X\n",
                 c1, c2, c3, c4, c7);
  else if (!ok && DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTLN("QMI8658 CTRL dump failed");
}

bool readQMI8658AccelGyro(int16_t &ax, int16_t &ay, int16_t &az,
                          int16_t &gx, int16_t &gy, int16_t &gz)
{
  uint8_t buf[12];
  if (!qmiReadBytes(QMI8658_REG_ACCEL_X_L, buf, sizeof(buf)))
    return false;
  ax = (int16_t)((uint16_t)buf[1] << 8 | buf[0]);
  ay = (int16_t)((uint16_t)buf[3] << 8 | buf[2]);
  az = (int16_t)((uint16_t)buf[5] << 8 | buf[4]);
  gx = (int16_t)((uint16_t)buf[7] << 8 | buf[6]);
  gy = (int16_t)((uint16_t)buf[9] << 8 | buf[8]);
  gz = (int16_t)((uint16_t)buf[11] << 8 | buf[10]);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Web UI（内嵌 HTML，仅 ENABLE_WIFI_AP=1 时使用）
// ═══════════════════════════════════════════════════════════════════════════
const char INDEX_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ESP32 Force/IMU Monitor</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
    body { font-family: Arial, sans-serif; margin: 12px; background: #0b1021; color: #e8f0ff; }
    h3 { margin: 0 0 12px 0; }
    .status-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .badge { padding: 4px 8px; border-radius: 6px; font-weight: 600; }
    .ok { background: #0a371b; color: #2de26d; }
    .bad { background: #3b0a0a; color: #ff6961; }
    .card-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 10px; }
    .card { background: #0f162d; border: 1px solid #1f2b4c; border-radius: 10px; padding: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }
    .card h4 { margin: 0 0 6px 0; font-size: 15px; color: #8fb9ff; }
    .value { font-size: 20px; font-weight: 700; }
    .chart-block { margin-bottom: 12px; }
    .chart-container { position: relative; background: #0f162d; border: 1px solid #1f2b4c; border-radius: 8px; padding: 6px; }
    .controls { display: flex; gap: 10px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
    #log { background: #0a190a; color: #00ff80; padding: 10px; height: 200px; overflow-y: auto; white-space: pre-wrap; border: 1px solid #1f2b4c; border-radius: 8px; display: none; }
    .muted { color: #8aa0c5; font-size: 13px; }
    .u-tooltip { position: absolute; pointer-events: none; background: rgba(12, 17, 35, 0.95); border: 1px solid #1f2b4c; border-radius: 6px; padding: 8px; font-size: 12px; color: #e8f0ff; box-shadow: 0 4px 12px rgba(0,0,0,0.35); }
    .u-tooltip table { border-collapse: collapse; }
    .u-tooltip td { padding: 2px 6px; }
    .btn { background: #1f2b4c; color: #e8f0ff; border: 1px solid #2f3f6c; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
    .btn:hover { background: #27365e; }
  </style>
  <style>
    .uplot { position: relative; width: 100%; height: 100%; }
    .uplot canvas { display: block; width: 100%; height: 100%; }
    .u-cursor-x, .u-cursor-y { position: absolute; pointer-events: none; background: rgba(255,255,255,0.5); }
    .u-cursor-x { width: 1px; top: 0; bottom: 0; }
    .u-cursor-y { height: 1px; left: 0; right: 0; }
    canvas { background: #0f162d; border: 1px solid #1f2b4c; border-radius: 8px; width: 100%; height: 160px; touch-action: none; }
    .chart-block { margin-bottom: 12px; }
  </style>
</head>
<body>
  <h3>ESP32 Force + IMU Streaming</h3>
  <div class="status-row">
    <span id="wsState" class="badge bad">❌ WS</span>
    <span id="rxHz" class="badge">Rx: 0 Hz</span>
    <span id="latency" class="badge">RTT: -- ms</span>
    <span id="sentDrop" class="badge">sent/drop: 0/0</span>
    <span id="headerText" class="muted"></span>
  </div>

  <div class="card-grid">
    <div class="card">
      <h4>Force (counts/N)</h4>
      <div class="value" id="forceVal">--</div>
    </div>
    <div class="card">
      <h4>Accel (mg)</h4>
      <div class="value" id="accVal">--</div>
    </div>
    <div class="card">
      <h4>Gyro (mdps)</h4>
      <div class="value" id="gyroVal">--</div>
    </div>
  </div>

  <div class="chart-block">
    <div id="forceChart" class="chart-container"></div>
  </div>
  <div class="chart-block">
    <div id="gyroChart" class="chart-container"></div>
  </div>

  <div class="controls">
    <button id="pauseBtn" class="btn">⏸️ Pause</button>
    <button id="tareBtn" class="btn">🎯 Tare</button>
    <label><input type="checkbox" id="logToggle" /> Show green log</label>
    <span class="muted">UI refresh @20Hz, log throttled @200ms, max 200 lines.</span>
  </div>
  <pre id="log"></pre>

  <script>
    class uPlot {
      constructor(opts, data, target) {
        this.opts = { cursorSnapX: false, showCursorY: true, ...opts };
        this.data = data;
        this.root = document.createElement('div');
        this.root.className = 'uplot';
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.root.appendChild(this.canvas);
        this.cursorX = document.createElement('div');
        this.cursorY = document.createElement('div');
        this.cursorX.className = 'u-cursor-x';
        this.cursorY.className = 'u-cursor-y';
        this.root.appendChild(this.cursorX);
        if (this.opts.showCursorY) this.root.appendChild(this.cursorY);
        (target || document.body).appendChild(this.root);
        this.hooks = { setCursor: [] };
        (opts.plugins || []).forEach((p) => {
          if (p.hooks && p.hooks.setCursor) this.hooks.setCursor.push(...p.hooks.setCursor);
        });
        this.cursor = { idx: null, left: 0, top: 0 };
        this.initSize();
        this.setData(data, true);
        this.bindEvents();
      }
      initSize() {
        const width = this.opts.width || this.root.clientWidth || 600;
        const height = this.opts.height || 200;
        this.width = width; this.height = height;
        const dpr = window.devicePixelRatio || 1; this.dpr = dpr;
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.imageSmoothingEnabled = true;
      }
      bindEvents() {
        let isDragging = false, dragStartX = 0;
        this.root.addEventListener('mousemove', (ev) => {
          const { x, y } = this.getEventPos(ev);
          this.setCursorByPos(x, y);
          if (isDragging) {
            const dx = ev.clientX - dragStartX; dragStartX = ev.clientX;
            const span = this.scales.x.max - this.scales.x.min;
            const delta = (dx / this.width) * span;
            this.setScale('x', { min: this.scales.x.min - delta, max: this.scales.x.max - delta });
          }
        });
        this.root.addEventListener('mouseleave', () => {
          this.cursor.idx = null;
          this.cursorX.style.display = 'none'; this.cursorY.style.display = 'none';
          this.callCursorHooks();
        });
        this.root.addEventListener('mousedown', (ev) => { isDragging = true; dragStartX = ev.clientX; });
        window.addEventListener('mouseup', () => { isDragging = false; });
        this.canvas.addEventListener('touchstart', (ev) => {
          ev.preventDefault();
          const touch = ev.touches[0]; if (!touch) return;
          const { x, y } = this.getEventPos(touch); this.setCursorByPos(x, y);
        }, { passive: false });
        this.canvas.addEventListener('touchmove', (ev) => {
          ev.preventDefault();
          const touch = ev.touches[0]; if (!touch) return;
          const { x, y } = this.getEventPos(touch); this.setCursorByPos(x, y);
        }, { passive: false });
        this.root.addEventListener('wheel', (ev) => {
          ev.preventDefault();
          const factor = ev.deltaY < 0 ? 0.9 : 1.1;
          const { min, max } = this.scales.x;
          const { x } = this.getEventPos(ev);
          const center = min + (max - min) * ((x || this.width / 2) / this.width);
          const newSpan = (max - min) * factor;
          this.setScale('x', { min: center - newSpan / 2, max: center + newSpan / 2 });
        }, { passive: false });
      }
      getEventPos(ev) {
        const rect = this.canvas.getBoundingClientRect();
        return {
          x: (ev.clientX - rect.left) * (this.width / rect.width),
          y: (ev.clientY - rect.top) * (this.height / rect.height)
        };
      }
      findNearestIdx(xs, xVal) {
        let lo = 0, hi = xs.length - 1;
        if (xVal <= xs[lo]) return lo;
        if (xVal >= xs[hi]) return hi;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (xs[mid] === xVal) return mid;
          if (xs[mid] < xVal) lo = mid; else hi = mid;
        }
        return (xVal - xs[lo] <= xs[hi] - xVal) ? lo : hi;
      }
      setCursorByPos(x, y) {
        const xs = this.data[0]; if (!xs.length) return;
        let idx, cursorX = x;
        if (this.opts.cursorSnapX) {
          const xMin = this.scales.x.min, xMax = this.scales.x.max, xSpan = xMax - xMin || 1;
          const xVal = xMin + (x / this.width) * xSpan;
          idx = this.findNearestIdx(xs, xVal);
          cursorX = ((xs[idx] - xMin) / xSpan) * this.width;
        } else {
          idx = Math.max(0, Math.min(xs.length - 1, Math.round((x / this.width) * (xs.length - 1))));
        }
        this.cursor.idx = idx; this.cursor.left = cursorX; this.cursor.top = y;
        this.cursorX.style.left = `${cursorX}px`; this.cursorX.style.display = 'block';
        if (this.opts.showCursorY) { this.cursorY.style.top = `${y}px`; this.cursorY.style.display = 'block'; }
        this.callCursorHooks();
      }
      callCursorHooks() { this.hooks.setCursor.forEach((fn) => fn(this)); }
      setScale(key, val) { this.scales[key] = { ...this.scales[key], ...val }; this.draw(); }
      setData(data, resetScales = true) {
        this.data = data;
        if (resetScales) {
          const xs = data[0], ys = data.slice(1).flat();
          this.scales = {
            x: { min: xs.length ? Math.min(...xs) : 0, max: xs.length ? Math.max(...xs) : 1 },
            y: { min: ys.length ? Math.min(...ys) : -1, max: ys.length ? Math.max(...ys) : 1 }
          };
        }
        this.draw();
      }
      destroy() { this.root.remove(); }
      drawAxes() {
        const ctx = this.ctx; ctx.save();
        ctx.strokeStyle = '#1f2b4c'; ctx.lineWidth = 1;
        const steps = 5;
        for (let i = 1; i < steps; i++) {
          const x = (i / steps) * this.width;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.height); ctx.stroke();
        }
        for (let i = 1; i < steps; i++) {
          const y = (i / steps) * this.height;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.width, y); ctx.stroke();
        }
        ctx.fillStyle = '#8aa0c5'; ctx.font = '11px Arial';
        const { min: xMin, max: xMax } = this.scales.x;
        const { min: yMin, max: yMax } = this.scales.y;
        const xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
        for (let i = 0; i <= steps; i++) {
          const x = (i / steps) * this.width;
          const xVal = xMin + (i / steps) * xSpan;
          ctx.fillText(this.opts.xValueFormatter ? this.opts.xValueFormatter(xVal) : xVal.toFixed(0), x + 2, this.height - 6);
        }
        for (let i = 0; i <= steps; i++) {
          const y = this.height - (i / steps) * this.height;
          const yVal = yMin + (i / steps) * ySpan;
          ctx.fillText(this.opts.yValueFormatter ? this.opts.yValueFormatter(yVal) : yVal.toFixed(0), 6, y - 4);
        }
        if (this.opts.xLabel) { ctx.fillStyle = '#8fb9ff'; ctx.fillText(this.opts.xLabel, this.width - 90, this.height - 6); }
        if (this.opts.yLabel) {
          ctx.save(); ctx.translate(12, this.height / 2); ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = '#8fb9ff'; ctx.fillText(this.opts.yLabel, 0, 0); ctx.restore();
        }
        ctx.restore();
      }
      drawSeries() {
        const ctx = this.ctx, xs = this.data[0], series = this.data.slice(1);
        const colors = (this.opts.series || []).slice(1).map((s) => s.stroke || '#1fa3ff');
        const { min: xMin, max: xMax } = this.scales.x;
        const { min: yMin, max: yMax } = this.scales.y;
        const xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
        series.forEach((ys, si) => {
          ctx.beginPath(); ctx.strokeStyle = colors[si] || '#1fa3ff';
          ctx.lineWidth = 1.25; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          ys.forEach((yVal, idx) => {
            const x = ((xs[idx] - xMin) / xSpan) * this.width;
            const y = this.height - ((yVal - yMin) / ySpan) * this.height;
            if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        });
      }
      drawTitles() {
        if (!this.opts.title) return;
        const ctx = this.ctx; ctx.save();
        ctx.fillStyle = '#8fb9ff'; ctx.font = 'bold 13px Arial';
        ctx.fillText(this.opts.title, 10, 16); ctx.restore();
      }
      draw() { this.ctx.clearRect(0, 0, this.width, this.height); this.drawAxes(); this.drawSeries(); this.drawTitles(); }
    }
  </script>
  <script>
    const wsBadge = document.getElementById('wsState');
    const rxHzEl = document.getElementById('rxHz');
    const latencyEl = document.getElementById('latency');
    const sentDropEl = document.getElementById('sentDrop');
    const forceVal = document.getElementById('forceVal');
    const accVal = document.getElementById('accVal');
    const gyroVal = document.getElementById('gyroVal');
    const headerText = document.getElementById('headerText');
    const logEl = document.getElementById('log');
    const logToggle = document.getElementById('logToggle');
    const pauseBtn = document.getElementById('pauseBtn');
    const tareBtn = document.getElementById('tareBtn');

    const buffer = [];
    const BUFFER_MAX = 2000;
    let ws, rxCounter = 0, rxHz = 0, latestSample = null, latencyMs = 0;
    let sentCount = 0, dropCount = 0, csvHeader = '', lastLogFlush = 0;
    const logLines = [];
    let paused = false;
    const xData = [], forceData = [], gzData = [];

    function setWsState(ok) {
      wsBadge.textContent = ok ? '✅ WS' : '❌ WS';
      wsBadge.classList.toggle('ok', ok);
      wsBadge.classList.toggle('bad', !ok);
    }

    function connect() {
      setWsState(false);
      ws = new WebSocket('ws://' + location.host + '/ws');
      ws.onopen = () => setWsState(true);
      ws.onclose = () => { setWsState(false); setTimeout(connect, 1000); };
      ws.onerror = () => setWsState(false);
      ws.onmessage = (ev) => handleMessage(ev.data);
    }

    function handleMessage(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('{')) {
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === 'meta' && msg.header) { csvHeader = msg.header; sentCount = msg.sent ?? sentCount; dropCount = msg.drop ?? dropCount; }
          else if (msg.type === 'pong') { if (msg.t) latencyMs = Date.now() - msg.t; sentCount = msg.sent ?? sentCount; dropCount = msg.drop ?? dropCount; }
          else if (msg.type === 'status') { sentCount = msg.sent ?? sentCount; dropCount = msg.drop ?? dropCount; }
        } catch (e) {}
        return;
      }
      if (trimmed.startsWith('#header,')) { csvHeader = trimmed.slice(8); return; }
      const parts = trimmed.split(',');
      if (parts.length < 8) return;
      const rec = { ts: Number(parts[0]), force: Number(parts[1]), ax: Number(parts[2]), ay: Number(parts[3]), az: Number(parts[4]), gx: Number(parts[5]), gy: Number(parts[6]), gz: Number(parts[7]) };
      buffer.push(rec); xData.push(rec.ts); forceData.push(rec.force); gzData.push(rec.gz);
      while (buffer.length > BUFFER_MAX) { buffer.shift(); xData.shift(); forceData.shift(); gzData.shift(); }
      latestSample = rec; rxCounter++;
      if (logToggle.checked) { logLines.push(trimmed); if (logLines.length > 200) logLines.shift(); }
    }

    function createPlot(containerId, title, color, dataRef, cursorSnapX = false, withTooltip = false, axisLabels = null) {
      const container = document.getElementById(containerId);
      const opts = { title, width: container.clientWidth || 640, height: 220, series: [{}, { stroke: color }], plugins: withTooltip ? [makeTooltipPlugin(container)] : [], cursorSnapX, showCursorY: !withTooltip };
      if (axisLabels) { opts.xLabel = axisLabels.xLabel; opts.yLabel = axisLabels.yLabel; opts.xValueFormatter = axisLabels.xValueFormatter; opts.yValueFormatter = axisLabels.yValueFormatter; }
      return new uPlot(opts, dataRef, container);
    }

    function makeTooltipPlugin(container) {
      const tooltip = document.createElement('div');
      tooltip.className = 'u-tooltip'; tooltip.style.display = 'none';
      container.appendChild(tooltip);
      return {
        hooks: { setCursor: [(u) => {
          const idx = u.cursor.idx;
          if (idx == null || !buffer[idx]) { tooltip.style.display = 'none'; return; }
          const rec = buffer[idx];
          tooltip.style.display = 'block';
          tooltip.innerHTML = `<table><tr><td>Time</td><td>${(rec.ts/1000).toFixed(3)} s</td></tr><tr><td>Force</td><td>${rec.force} counts</td></tr></table>`;
          const left = Math.min(container.clientWidth - tooltip.offsetWidth - 4, Math.max(4, u.cursor.left + 8));
          const top = Math.min(container.clientHeight - tooltip.offsetHeight - 4, Math.max(4, u.cursor.top + 8));
          tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
        }]}
      };
    }

    const forcePlot = createPlot('forceChart', 'Force – Time', '#1fa3ff', [xData, forceData], true, true, { xLabel: 'Time (s)', yLabel: 'Force (counts)', xValueFormatter: (v) => (v/1000).toFixed(1), yValueFormatter: (v) => v.toFixed(0) });
    const gyroPlot = createPlot('gyroChart', 'GyroZ – Time (mdps)', '#38f2af', [xData, gzData]);

    let inspecting = false;
    forcePlot.canvas.addEventListener('pointerdown', (ev) => {
      inspecting = true; paused = true; pauseBtn.textContent = '▶️ Resume';
      forcePlot.canvas.setPointerCapture(ev.pointerId);
      const { x, y } = forcePlot.getEventPos(ev); forcePlot.setCursorByPos(x, y);
    });
    forcePlot.canvas.addEventListener('pointermove', (ev) => {
      if (!inspecting) return;
      const { x, y } = forcePlot.getEventPos(ev); forcePlot.setCursorByPos(x, y);
    });
    forcePlot.canvas.addEventListener('pointerup', (ev) => { inspecting = false; forcePlot.canvas.releasePointerCapture(ev.pointerId); });

    function updatePlots() {
      if (!xData.length) return;
      const reset = !paused;
      forcePlot.setData([xData, forceData], reset);
      gyroPlot.setData([xData, gzData], reset);
      if (!paused) {
        const lastTs = xData[xData.length - 1], span = 20000;
        forcePlot.setScale('x', { min: lastTs - span, max: lastTs });
        gyroPlot.setScale('x', { min: lastTs - span, max: lastTs });
      }
    }

    setInterval(() => {
      rxHzEl.textContent = `Rx: ${rxHz} Hz`;
      latencyEl.textContent = `RTT: ${latencyMs || '--'} ms`;
      sentDropEl.textContent = `sent/drop: ${sentCount}/${dropCount}`;
      headerText.textContent = csvHeader ? `header: ${csvHeader}` : '';
      if (latestSample) {
        forceVal.textContent = latestSample.force;
        accVal.textContent = `${latestSample.ax}, ${latestSample.ay}, ${latestSample.az}`;
        gyroVal.textContent = `${latestSample.gx}, ${latestSample.gy}, ${latestSample.gz}`;
      }
      updatePlots();
      const now = Date.now();
      if (logToggle.checked && now - lastLogFlush > 200) { lastLogFlush = now; logEl.textContent = logLines.slice(-200).join('\n'); }
    }, 50);

    logToggle.addEventListener('change', () => { logEl.style.display = logToggle.checked ? 'block' : 'none'; if (!logToggle.checked) logEl.textContent = ''; });
    pauseBtn.addEventListener('click', () => { paused = !paused; pauseBtn.textContent = paused ? '▶️ Resume' : '⏸️ Pause'; });
    tareBtn.addEventListener('click', () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('tare'); });
    connect();
  </script>
</body>
</html>
)rawliteral";

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket 辅助函数
// ═══════════════════════════════════════════════════════════════════════════
template <typename T, typename = void>
struct HasAvailableForWriteAll : std::false_type
{
};

template <typename T>
struct HasAvailableForWriteAll<T, decltype((void)std::declval<T>().availableForWriteAll())> : std::true_type
{
};

bool websocketWritable()
{
  if (ws.count() == 0)
    return false;
#if __cpp_if_constexpr >= 201606
  if constexpr (HasAvailableForWriteAll<AsyncWebSocket>::value)
    return ws.availableForWriteAll();
  else
    return ws.count() > 0;
#else
  return ws.availableForWriteAll();
#endif
}

void sendWsMeta(AsyncWebSocketClient *client)
{
  if (!client)
    return;
  char meta[160];
  int metaLen = snprintf(meta, sizeof(meta),
                         "{\"type\":\"meta\",\"device\":\"TG_Reha_ForceIMU\",\"header\":\"%s\",\"sent\":%lu,\"drop\":%lu}",
                         CSV_HEADER, (unsigned long)wsSentCount, (unsigned long)wsDropCount);
  if (metaLen > 0 && metaLen < (int)sizeof(meta) && client->canSend())
  {
    meta[metaLen] = '\0';
    client->text(meta);
  }
  char headerLine[120];
  int headerLen = snprintf(headerLine, sizeof(headerLine), "#header,%s", CSV_HEADER);
  if (headerLen > 0 && headerLen < (int)sizeof(headerLine) && client->canSend())
  {
    headerLine[headerLen] = '\0';
    client->text(headerLine);
  }
}

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
               AwsEventType type, void *arg, uint8_t *data, size_t len)
{
  (void)server;
  if (type == WS_EVT_CONNECT)
  {
    if (DEBUG_LOG)
      DEBUG_PRINTF("WS client #%u connected\n", client->id());
    sendWsMeta(client);
  }
  else if (type == WS_EVT_DISCONNECT)
  {
    if (DEBUG_LOG)
      DEBUG_PRINTF("WS client #%u disconnected\n", client->id());
  }
  else if (type == WS_EVT_DATA)
  {
    AwsFrameInfo *info = (AwsFrameInfo *)arg;
    if (info && info->final && info->index == 0 && info->opcode == WS_TEXT && len < 128)
    {
      char msg[128];
      size_t copyLen = min(len, sizeof(msg) - 1);
      memcpy(msg, data, copyLen);
      msg[copyLen] = '\0';

      if (strstr(msg, "\"ping\""))
      {
        char *tPos = strstr(msg, "\"t\":");
        unsigned long tVal = tPos ? strtoul(tPos + 4, nullptr, 10) : 0;
        char pong[120];
        int pongLen = snprintf(pong, sizeof(pong),
                               "{\"type\":\"pong\",\"t\":%lu,\"sent\":%lu,\"drop\":%lu}",
                               tVal, (unsigned long)wsSentCount, (unsigned long)wsDropCount);
        if (pongLen > 0 && pongLen < (int)sizeof(pong) && client->canSend())
        {
          pong[pongLen] = '\0';
          client->text(pong);
        }
        else
          wsDropCount++;
      }
      else if (strcmp(msg, "tare") == 0)
      {
        requestTare = true;
        const char ack[] = "{\"type\":\"tare\",\"status\":\"ok\"}";
        if (client->canSend())
          client->text(ack);
        else
          wsDropCount++;
      }
      else if (strcmp(msg, "IMU_ZERO") == 0)
        handleImuZeroCommand();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WiFi AP 与 HTTP 服务器
// ═══════════════════════════════════════════════════════════════════════════
void setupWiFiAp()
{
#if ENABLE_WIFI_AP
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(WIFI_AP_IP, WIFI_AP_GATEWAY, WIFI_AP_SUBNET);
  WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASS);
  if (DEBUG_LOG)
    DEBUG_PRINTF("AP started SSID:%s PASS:%s IP:%s\n",
                 WIFI_AP_SSID, WIFI_AP_PASS, WiFi.softAPIP().toString().c_str());
#endif
}

void setupHttpServer()
{
#if ENABLE_WIFI_AP
  ws.onEvent(onWsEvent);
  webServer.addHandler(&ws);
  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request)
               { request->send_P(200, "text/html", INDEX_HTML); });
  webServer.on("/health", HTTP_GET, [](AsyncWebServerRequest *request)
               { request->send(200, "text/plain", "ok"); });
  webServer.begin();
  if (DEBUG_LOG)
    DEBUG_PRINTLN("HTTP/WebSocket server started on 80");
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// BLE 回调类与服务初始化
// ═══════════════════════════════════════════════════════════════════════════
class MyServerCallbacks : public BLEServerCallbacks
{
  void onConnect(BLEServer *pServer) override
  {
    (void)pServer;
    deviceConnected = true;
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTLN("[BLE] client connected");
  }
  void onDisconnect(BLEServer *pServer) override
  {
    (void)pServer;
    deviceConnected = false;
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTLN("[BLE] client disconnected, restart advertising");
    BLEDevice::startAdvertising();
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks
{
  void onWrite(BLECharacteristic *characteristic) override
  {
    String value = characteristic->getValue().c_str();
    if (value == "IMU_ZERO")
      handleImuZeroCommand();
  }
};

/**
 * setupBle() — 使用 g_uuidStr 作为服务 UUID。
 * [重要] 必须在 initDeviceUUID() 之后调用。
 */
void setupBle()
{
#if ENABLE_BLE
  // 1. 初始化，名字加个后缀测试（强制 iOS 刷新缓存）
  BLEDevice::init("ESP32-forcedet-v4");

  // 删除原来的 setMTU(185)，iOS 会自动处理
  // BLEDevice::setMTU(185);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new MyServerCallbacks());

  // 2. 创建服务
  BLEService *service = server->createService(BLEUUID(BLE_SERVICE_UUID));

  // 3. 创建数据流特征值
  streamCharacteristic = service->createCharacteristic(
      BLEUUID(BLE_CHAR_UUID),
      BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);

  // 通行证
  streamCharacteristic->addDescriptor(new BLE2902());

  // 4. 创建控制特征值
  controlCharacteristic = service->createCharacteristic(
      BLEUUID(BLE_CTRL_CHAR_UUID),
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_READ);
  controlCharacteristic->setCallbacks(new ControlCallbacks());

  controlCharacteristic->setValue("ready");
  streamCharacteristic->setValue("ready");

  // 5. 启动
  service->start();

  // 6. 配置广播参数（对齐苹果规范）
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLEUUID(BLE_SERVICE_UUID));

  // 开启扫描响应（方便 iOS 识别动态 Service UUID）
  advertising->setScanResponse(true);

  // 这里的数值是“期望值”，实际生效由 onConnect 里的 updateConnParams 决定
  advertising->setMinPreferred(0x10); // 20ms
  advertising->setMaxPreferred(0x20); // 40ms

  advertising->start();

  if (DEBUG_LOG)
  {
    DEBUG_PRINTLN("BLE iOS-Compatible Service Started");
  }
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// 开机自动校准（NAU7802 零偏 + QMI8658 陀螺/加速度计）
// ═══════════════════════════════════════════════════════════════════════════
void autoCalibrateOnBoot()
{
  if (!PLOT_MODE && DEBUG_LOG)
  {
    DEBUG_PRINTLN("Auto calibration start (NAU7802 + QMI8658 gyro + accel XYZ)...");
    DEBUG_PRINTLN("Calibrating NAU7802, please keep load cell unloaded");
  }

  tareBoot(); // 开机精准调零：320 个样本（@320SPS ≈ 1 秒），仅在 setup 阶段调用

  if (DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTF("NAU7802 zero offset: %ld\n", (long)zeroOffset);

  if (!qmiReady)
  {
    if (DEBUG_LOG && !PLOT_MODE)
    {
      DEBUG_PRINTLN("QMI8658 not ready, skip IMU calibration");
      DEBUG_PRINTLN("Auto calibration done.");
    }
    return;
  }

  const int samples = 200;
  int64_t sumAx = 0, sumAy = 0, sumAz = 0;
  int64_t sumGx = 0, sumGy = 0, sumGz = 0;
  int16_t ax, ay, az, gx, gy, gz;

  if (DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTLN("Calibrating QMI8658 gyro + accel XYZ, keep board still and level...");

  for (int i = 0; i < samples; i++)
  {
    if (readQMI8658AccelGyro(ax, ay, az, gx, gy, gz))
    {
      sumAx += ax;
      sumAy += ay;
      sumAz += az;
      sumGx += gx;
      sumGy += gy;
      sumGz += gz;
    }
    delay(2);
  }
  accelOffsetX = (int32_t)(sumAx / samples);
  accelOffsetY = (int32_t)(sumAy / samples);
  accelOffsetZ = (int32_t)(sumAz / samples);
  gyroOffsetX = (int16_t)(sumGx / samples);
  gyroOffsetY = (int16_t)(sumGy / samples);
  gyroOffsetZ = (int16_t)(sumGz / samples);

  accelBiasGX = accelOffsetX / ACCEL_LSB_PER_G;
  accelBiasGY = accelOffsetY / ACCEL_LSB_PER_G;
  accelBiasGZ = accelOffsetZ / ACCEL_LSB_PER_G;
  gyroBiasDpsX = gyroOffsetX / GYRO_LSB_PER_DPS;
  gyroBiasDpsY = gyroOffsetY / GYRO_LSB_PER_DPS;
  gyroBiasDpsZ = gyroOffsetZ / GYRO_LSB_PER_DPS;

  if (DEBUG_LOG && !PLOT_MODE)
  {
    DEBUG_PRINTF("Accel offset (raw): X=%ld Y=%ld Z=%ld\n", (long)accelOffsetX, (long)accelOffsetY, (long)accelOffsetZ);
    DEBUG_PRINTF("Accel bias (g): X=%.5f Y=%.5f Z=%.5f\n", accelBiasGX, accelBiasGY, accelBiasGZ);
    DEBUG_PRINTF("Gyro offset (raw): X=%d Y=%d Z=%d\n", gyroOffsetX, gyroOffsetY, gyroOffsetZ);
    DEBUG_PRINTF("Gyro bias (dps): X=%.5f Y=%.5f Z=%.5f\n", gyroBiasDpsX, gyroBiasDpsY, gyroBiasDpsZ);
    DEBUG_PRINTLN("Auto calibration done.");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// setup() — 初始化序列
// ─────────────────────────────────────────────────────────────────────────
// 关键调用顺序：
//   1. Serial.begin()
//   2. initDeviceUUID()    ← [新增] MAC→UUID v5，必须在 setupBle() 之前
//   3. setupWiFiAp() / setupHttpServer() / setupBle()
//   4. i2cBus / NAU7802 / QMI8658 初始化
//   5. [修复] delay(500) NAU7802 校准后稳定等待
//   6. autoCalibrateOnBoot()
//   7. FreeRTOS Task 启动
// ═══════════════════════════════════════════════════════════════════════════
void setup()
{
#if ENABLE_SERIAL || DEBUG_LOG
  Serial.begin(SERIAL_BAUD);
  delay(100);
#endif

  // ── 步骤 1：生成设备唯一 BLE 服务 UUID（必须在 setupBle() 之前）──────────
  initDeviceUUID();

  // ── 步骤 2：网络与 BLE 服务 ────────────────────────────────────────────────
  setupWiFiAp();
  setupHttpServer();
  setupBle();

  // ── 步骤 3：I2C 总线与传感器初始化 ─────────────────────────────────────────
  i2cBus.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  pinMode(TARE_BTN_PIN, INPUT_PULLUP);

  if (!nau.begin(&i2cBus))
  {
    if (DEBUG_LOG && !PLOT_MODE)
      DEBUG_PRINTLN("NAU7802 not found");
    for (;;)
      delay(10);
  }

  nau.setLDO(NAU7802_3V0);
  nau.setGain(NAU7802_GAIN_64);
  nau.setRate(NAU7802_RATE_320SPS);       // 320SPS，适合动态力测量 NAU7802_RATE_320SPS   NAU7802_RATE_80SPS
  nau.calibrate(NAU7802_CALMOD_INTERNAL); // AFE 内部校准
  nau.calibrate(NAU7802_CALMOD_OFFSET);   // AFE 偏置校准
  delay(500);                             // [修复] 等待 AFE 校准后输出稳定（原代码无此等待）

  qmiReady = initQMI8658();

  if (DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTF("QMI8658 config: CTRL2=0x%02X CTRL3=0x%02X, ACCEL_CAL=%s, GYRO_CAL=%s\n",
                 0x15, 0x95,
                 USE_ACCEL_OFFSET_CAL ? "true" : "false",
                 USE_GYRO_OFFSET_CAL ? "true" : "false");

  // ── 步骤 4：开机自动校准 ────────────────────────────────────────────────────
  autoCalibrateOnBoot();

  // ── 步骤 5：串口打印 IMU 初始化结果（方便诊断"IMU不动"）─────────────────────
#if ENABLE_SERIAL || DEBUG_LOG
  Serial.printf("[INIT] qmiReady=%s  zeroOffset=%ld\n",
                qmiReady ? "true" : "false ← IMU 未就绪，请检查 I2C 接线",
                (long)zeroOffset);
  Serial.println("[INIT] 串口命令: 'CAL' = 打印标定辅助, 'IMU_ZERO' = IMU 归零");
  Serial.println("[INIT] 串口命令: 'STATUS' = 立即打印当前原始数据 / IMU / BLE 诊断信息");
  Serial.println("[INIT] v2 debug monitor enabled: periodic raw force / IMU / BLE status output");
#endif

  // ── 步骤 5：启动 FreeRTOS 任务 ──────────────────────────────────────────────
#if ENABLE_WS
  xTaskCreatePinnedToCore(wsSendTask, "ws-send", 4096, nullptr, 1, &wsTaskHandle, 1);
#endif
  // BLE 不需要独立任务，在 loop() 中即时发送（带频率限制）
}

// ═══════════════════════════════════════════════════════════════════════════
// loop() — 主循环
// ═══════════════════════════════════════════════════════════════════════════
void loop()
{
  static float filt = 0.0f;
  static bool filtInit = false;
  static bool tareStableState = HIGH;
  static bool tareLastRead = HIGH;
  static uint32_t tareLastChangeMs = 0;
  static uint32_t nextImuSampleUs = micros();

  uint32_t nowMs = millis();
  uint32_t nowUs = micros();

  // ── 非阻塞按键消抖（下降沿触发 tare）──────────────────────────────────────
  bool tareRead = digitalRead(TARE_BTN_PIN);
  if (tareRead != tareLastRead)
  {
    tareLastRead = tareRead;
    tareLastChangeMs = nowMs;
  }
  if ((uint32_t)(nowMs - tareLastChangeMs) >= 30 && tareRead != tareStableState)
  {
    tareStableState = tareRead;
    if (tareStableState == LOW)
      tare();
  }

  if (requestTare)
  {
    requestTare = false;
    tare();
  }

#if ENABLE_SERIAL
  if (Serial.available())
  {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.equalsIgnoreCase("IMU_ZERO"))
      handleImuZeroCommand();
    else if (cmd.equalsIgnoreCase("CAL"))
      printCalibrationHelper(); // [新增] 串口输入 "CAL" 触发标定辅助打印
    else if (cmd.equalsIgnoreCase("STATUS"))
      printDiagStatus("manual");
  }
#endif

  // ── NAU7802 力传感器采样（非阻塞，含软件抽取 DECIM_N=2 → 有效 ~160Hz）────────
  // 硬件以 320SPS 持续输出，每 DECIM_N 个原始样本求均值后才产生一个有效输出。
  // 中间样本只做累加，不进入 ring buffer / BLE / 串口，不影响任何下游逻辑。
  static int32_t decimAccum = 0; // 抽取累加器
  static int decimCount = 0;     // 已累加样本数

  while (nau.available())
  {
    int32_t rawSingle = (int32_t)nau.read() - zeroOffset;

    // ── 抽取累加 ────────────────────────────────────────────────────────────
    decimAccum += rawSingle;
    decimCount++;
    if (decimCount < DECIM_N)
      continue; // 样本不够，等下一个，不执行任何下游操作

    // 凑够 DECIM_N 个，求均值作为本次有效输出
    int32_t raw = decimAccum / DECIM_N;
    decimAccum = 0;
    decimCount = 0;
    // ────────────────────────────────────────────────────────────────────────

    sampleCountInWindow++;

    uint32_t sampleTs = micros();
    if (lastSampleTsUs != 0)
    {
      uint32_t delta = sampleTs - lastSampleTsUs;
      minSampleIntervalUs = min(minSampleIntervalUs, delta);
      maxSampleIntervalUs = max(maxSampleIntervalUs, delta);
      sumSampleIntervalUs += delta;
      sampleIntervalCount++;
    }
    lastSampleTsUs = sampleTs;

    // EMA 滤波（α=0.15，用于展示字段 cn，不影响 BLE 流）
    if (!filtInit)
    {
      filt = (float)raw;
      filtInit = true;
    }
    else
    {
      filt += DISPLAY_ALPHA * ((float)raw - filt);
    }

    latestForceSnapshot.tsUs = sampleTs;
    latestForceSnapshot.raw = raw;          // 抽取均值（有效输出）
    latestForceSnapshot.cn = (int32_t)filt; // EMA 平滑值，供展示
    rawFrameCount++;
    latestForceSnapshot.cn = (int32_t)filt;
    rawFrameCount++;
    if (!rawEverUpdated)
    {
      rawEverUpdated = true;
      lastRawObserved = raw;
      if (DEBUG_LOG && !PLOT_MODE)
        DEBUG_PRINTF("[RAW] first sample raw=%ld filt=%ld\n", (long)raw, (long)latestForceSnapshot.cn);
    }
    else if (raw != lastRawObserved)
    {
      rawValueChangeCount++;
      lastRawObserved = raw;
    }

    SampleRecord rec = makeSnapshot(sampleTs);

    bool dropped = false;
    ringPush(rec, dropped);
    if (dropped)
      forceDropCountInWindow++;

    portENTER_CRITICAL(&sampleMux);
    latestSample = rec;
    portEXIT_CRITICAL(&sampleMux);

    // BLE 即时发送（带频率限制，最高 200Hz）
#if ENABLE_BLE
    uint32_t nowUsBle = micros();
    if (nowUsBle - lastBleSendUs >= BLE_MIN_INTERVAL_US)
    {
      sendBleFrame(rec.force, rec.angleDegX100);
      sendCountInWindow++;
      lastBleSendUs = nowUsBle;
    }
#endif

#if ENABLE_SERIAL
    if (DEBUG_LOG && !PLOT_MODE)
      printRawDebugLine(raw, (int32_t)filt);
#endif
  }

  // ── IMU 定时采样（100Hz）──────────────────────────────────────────────────
  // [修复] 在 NAU 循环（含 BLE notify）之后刷新 nowUs，
  //        否则 nowUs 使用 loop() 开头的旧值，IMU 判断可能每帧都失效，
  //        导致 IMU 采样被持续跳过（"IMU 变化看不到"的根本原因）。
  nowUs = micros();
  const uint32_t imuIntervalUs = 10000;
  while (qmiReady && (int32_t)(nowUs - nextImuSampleUs) >= 0)
  {
    nextImuSampleUs += imuIntervalUs;
    int16_t ax, ay, az, gx, gy, gz;
    if (readQMI8658AccelGyro(ax, ay, az, gx, gy, gz))
    {
      imuCountInWindow++;
      imuFrameCount++;
      int32_t axCal = (int32_t)ax - accelOffsetX;
      int32_t ayCal = (int32_t)ay - accelOffsetY;
      int32_t azCal = (int32_t)az - accelOffsetZ;
      int32_t gxCal = (int32_t)gx - gyroOffsetX;
      int32_t gyCal = (int32_t)gy - gyroOffsetY;
      int32_t gzCal = (int32_t)gz - gyroOffsetZ;

      ImuSnapshot snap{};
      snap.imu_ts_us = micros();
      snap.imu_seq = latestImuSnapshot.imu_seq + 1;
      snap.axCal = USE_ACCEL_OFFSET_CAL ? axCal : ax;
      snap.ayCal = USE_ACCEL_OFFSET_CAL ? ayCal : ay;
      snap.azCal = USE_ACCEL_OFFSET_CAL ? azCal : az;
      snap.gxCal = USE_GYRO_OFFSET_CAL ? gxCal : gx;
      snap.gyCal = USE_GYRO_OFFSET_CAL ? gyCal : gy;
      snap.gzCal = USE_GYRO_OFFSET_CAL ? gzCal : gz;

      const float dt = imuIntervalUs * 1e-6f;
      float gxDps = snap.gxCal / GYRO_LSB_PER_DPS;
      float gyDps = snap.gyCal / GYRO_LSB_PER_DPS;
      fusedRollRad += gxDps * 3.14159265359f / 180.0f * dt;
      fusedPitchRad += gyDps * 3.14159265359f / 180.0f * dt;

      float axg = snap.axCal / ACCEL_LSB_PER_G;
      float ayg = snap.ayCal / ACCEL_LSB_PER_G;
      float azg = snap.azCal / ACCEL_LSB_PER_G;
      float rollAcc = atan2f(ayg, azg);
      float pitchAcc = atan2f(-axg, sqrtf(ayg * ayg + azg * azg));
      constexpr float alpha = 0.98f;
      fusedRollRad = alpha * fusedRollRad + (1.0f - alpha) * rollAcc;
      fusedPitchRad = alpha * fusedPitchRad + (1.0f - alpha) * pitchAcc;

      qCurrent = quatFromEuler(fusedRollRad, fusedPitchRad, 0.0f);
      Quaternion qDelta = quatMultiply(quatInverse(qReference), qCurrent);
      quatNormalize(qDelta);

      float relRoll = 0.0f, relPitch = 0.0f, relYaw = 0.0f;
      quatToEuler(qDelta, relRoll, relPitch, relYaw);
      float tilt = acosf(constrain(cosf(relRoll) * cosf(relPitch), -1.0f, 1.0f));

      snap.relRollDegX100 = (int16_t)lrintf(relRoll * 18000.0f / 3.14159265359f);
      snap.relPitchDegX100 = (int16_t)lrintf(relPitch * 18000.0f / 3.14159265359f);
      snap.tiltDegX100 = (int16_t)lrintf(tilt * 18000.0f / 3.14159265359f);
      latestImuSnapshot = snap;
      latestAngleDegX100 = selectAngleByChannel(snap);
      if (!imuEverUpdated)
      {
        imuEverUpdated = true;
        if (DEBUG_LOG && !PLOT_MODE)
        {
          DEBUG_PRINTF("[IMU] first sample ax=%ld ay=%ld az=%ld gx=%ld gy=%ld gz=%ld angle=%d\n",
                       (long)snap.axCal,
                       (long)snap.ayCal,
                       (long)snap.azCal,
                       (long)snap.gxCal,
                       (long)snap.gyCal,
                       (long)snap.gzCal,
                       (int)latestAngleDegX100);
        }
      }

#if ENABLE_SERIAL
      if (PLOT_MODE)
        printImuCurvesLine(snap);
#endif
    }
    nowUs = micros();
  }

  emitStats();
}

void printRawDebugLine(int32_t raw, int32_t filtCounts)
{
#if ENABLE_SERIAL
  static uint32_t lastPrintMs = 0;
  uint32_t nowMs = millis();
  if ((uint32_t)(nowMs - lastPrintMs) < RAW_DEBUG_INTERVAL_MS)
    return;

  lastPrintMs = nowMs;

  const ImuSnapshot imu = latestImuSnapshot;
  DEBUG_PRINTF("[RAW] ts=%lu raw=%ld filt=%ld force_g=%.2f filt_g=%.2f angle=%.2f imu_seq=%lu ax=%ld ay=%ld az=%ld gx=%ld gy=%ld gz=%ld ble_connected=%s ble_sent=%lu\n",
               (unsigned long)(latestForceSnapshot.tsUs / 1000UL),
               (long)raw,
               (long)filtCounts,
               countsToGrams(raw),
               countsToGrams(filtCounts),
               latestAngleDegX100 / 100.0f,
               (unsigned long)imu.imu_seq,
               (long)imu.axCal,
               (long)imu.ayCal,
               (long)imu.azCal,
               (long)imu.gxCal,
               (long)imu.gyCal,
               (long)imu.gzCal,
               deviceConnected ? "true" : "false",
               (unsigned long)bleNotifySentCount);
#endif
}

void printDiagStatus(const char *reason)
{
#if ENABLE_SERIAL
  DEBUG_PRINTF("[DIAG] reason=%s raw_seen=%s raw_frames=%lu raw_changes=%lu last_raw=%ld imu_seen=%s imu_frames=%lu imu_seq=%lu ble_connected=%s ble_attempt=%lu ble_sent=%lu skip_nochar=%lu skip_disconnected=%lu ble_ever_sent=%s qmiReady=%s zeroOffset=%ld\n",
               reason ? reason : "periodic",
               rawEverUpdated ? "true" : "false",
               (unsigned long)rawFrameCount,
               (unsigned long)rawValueChangeCount,
               (long)latestForceSnapshot.raw,
               imuEverUpdated ? "true" : "false",
               (unsigned long)imuFrameCount,
               (unsigned long)latestImuSnapshot.imu_seq,
               deviceConnected ? "true" : "false",
               (unsigned long)bleNotifyAttemptCount,
               (unsigned long)bleNotifySentCount,
               (unsigned long)bleNotifySkippedNoCharCount,
               (unsigned long)bleNotifySkippedDisconnectedCount,
               bleEverSent ? "true" : "false",
               qmiReady ? "true" : "false",
               (long)zeroOffset);
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV 行构建与串口输出
// ═══════════════════════════════════════════════════════════════════════════
size_t buildCsvLine(const SampleRecord &s, char *out, size_t outLen)
{
  if (!out || outLen == 0)
    return 0;
  int len = snprintf(out, outLen, "%lu,%ld,%d\n",
                     (unsigned long)s.tsMs,
                     (long)s.force,
                     (int)s.angleDegX100);
  return (len > 0 && (size_t)len < outLen) ? (size_t)len : 0;
}

void printCsvLine(const SampleRecord &s)
{
#if ENABLE_SERIAL
  char line[160];
  size_t len = buildCsvLine(s, line, sizeof(line));
  if (len > 0)
    Serial.write((const uint8_t *)line, len);
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// FreeRTOS 任务：WebSocket 发送
// ═══════════════════════════════════════════════════════════════════════════
void wsSendTask(void *param)
{
  (void)param;
#if ENABLE_WS
  const TickType_t waitTicks = pdMS_TO_TICKS(WS_SEND_INTERVAL_MS);
  char line[160];
  uint32_t lastStatusMs = 0;
  for (;;)
  {
    SampleRecord snap;
    portENTER_CRITICAL(&sampleMux);
    snap = latestSample;
    portEXIT_CRITICAL(&sampleMux);

    size_t len = buildCsvLine(snap, line, sizeof(line));
    if (len > 0 && ws.count() > 0)
    {
      if (websocketWritable())
      {
        ws.textAll(line);
        wsSentCount++;
        sendCountInWindow++;
      }
      else
        wsDropCount++;
    }

    uint32_t nowMs = millis();
    if ((uint32_t)(nowMs - lastStatusMs) >= 1000 && ws.count() > 0)
    {
      lastStatusMs = nowMs;
      char status[120];
      int statusLen = snprintf(status, sizeof(status),
                               "{\"type\":\"status\",\"sent\":%lu,\"drop\":%lu}",
                               (unsigned long)wsSentCount, (unsigned long)wsDropCount);
      if (statusLen > 0 && statusLen < (int)sizeof(status) && websocketWritable())
      {
        status[statusLen] = '\0';
        ws.textAll(status);
      }
      else
        wsDropCount++;
    }
    ws.cleanupClients();
    vTaskDelay(waitTicks);
  }
#else
  vTaskDelete(nullptr);
#endif
}

// ═══════════════════════════════════════════════════════════════════════════
// 统计信息输出（每秒一次，DEBUG_LOG=1 时有效）
// ═══════════════════════════════════════════════════════════════════════════
void emitStats()
{
  uint32_t nowMs = millis();
  if ((uint32_t)(nowMs - lastStatsMs) < 1000)
    return;
  uint32_t elapsedMs = nowMs - lastStatsMs;

  float sampleHz = elapsedMs ? (1000.0f * sampleCountInWindow) / elapsedMs : 0.0f;
  float imuHz = elapsedMs ? (1000.0f * imuCountInWindow) / elapsedMs : 0.0f;
  float sendHz = elapsedMs ? (1000.0f * sendCountInWindow) / elapsedMs : 0.0f;
  uint32_t minJitter = (minSampleIntervalUs == UINT32_MAX) ? 0 : minSampleIntervalUs;
  float avgJitter = sampleIntervalCount
                        ? ((float)sumSampleIntervalUs / sampleIntervalCount)
                        : 0.0f;

  if (DEBUG_LOG && !PLOT_MODE)
    DEBUG_PRINTF("stats force_hz=%.1f imu_hz=%.1f send_hz=%.1f drops=%lu "
                 "jitter_us[min/avg/max]=%lu/%.1f/%lu ring=%u\n",
                 sampleHz, imuHz, sendHz, (unsigned long)forceDropCountInWindow,
                 (unsigned long)minJitter, avgJitter, (unsigned long)maxSampleIntervalUs,
                 (unsigned int)ringCount());

  if (DEBUG_LOG && !PLOT_MODE)
  {
    static uint32_t lastDiagStatusMs = 0;
    if ((uint32_t)(nowMs - lastDiagStatusMs) >= DIAG_STATUS_INTERVAL_MS)
    {
      printDiagStatus("periodic");
      lastDiagStatusMs = nowMs;
    }
  }

  // [新增] IMU 健康检查：如果 imuHz 远低于预期（100Hz），打印警告
  if (DEBUG_LOG && !PLOT_MODE && qmiReady && imuHz < 50.0f)
    DEBUG_PRINTF("  ⚠ IMU 采样率偏低 (%.1f Hz)，预期 ~100 Hz。"
                 "可能原因: nowUs 刷新问题或 I2C 阻塞\n",
                 imuHz);

  // [新增] 打印 EMA 滤波后的克值（标定后有意义）
  if (DEBUG_LOG && !PLOT_MODE && SCALE_SENSITIVITY > 0.0f)
  {
    DEBUG_PRINTF("  force_filt_g=%.2f  force_raw_g=%.2f\n",
                 countsToGrams(latestForceSnapshot.cn),
                 countsToGrams(latestForceSnapshot.raw));
    DEBUG_PRINTF("******************************************\n");
  }

  uint32_t imuSeqDelta = latestImuSnapshot.imu_seq - lastImuSeqPrinted;
  // if (DEBUG_LOG)
  //   Serial.printf("imu_seq_delta:%lu roll:%d pitch:%d tilt:%d selected:%d\n",
  //                 (unsigned long)imuSeqDelta,
  //                 (int)latestImuSnapshot.relRollDegX100,
  //                 (int)latestImuSnapshot.relPitchDegX100,
  //                 (int)latestImuSnapshot.tiltDegX100,
  //                 (int)latestAngleDegX100);

  lastImuSeqPrinted = latestImuSnapshot.imu_seq;
  lastStatsMs = nowMs;
  sampleCountInWindow = 0;
  imuCountInWindow = 0;
  sendCountInWindow = 0;
  forceDropCountInWindow = 0;
  minSampleIntervalUs = UINT32_MAX;
  maxSampleIntervalUs = 0;
  sumSampleIntervalUs = 0;
  sampleIntervalCount = 0;
}
