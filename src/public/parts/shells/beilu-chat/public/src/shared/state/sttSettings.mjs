/**
 * [sttSettings.mjs] — STT 录音设置(录音设备/服务端降噪)双 store 写侧收口。
 *
 * why(凛倾 2026-07-22"再看看其他地方的散写"):同一设置有两个消费域——
 *   web 录音(messageInput.mjs:374 / companionChat.mjs:169 读 localStorage,后端不在也能用)
 *   + 桌宠🎤(Electron 经 pet-settings 轮询读 petSettings.sttDevice/sttDenoise)。
 *   此前两个写入口语义不同:陪伴面板双写(localStorage+petSettings),扩展面板 STT 页只写
 *   localStorage——从扩展面板改设备/降噪,桌宠🎤永远用旧值(与 petEnabled 散写同病:
 *   同一事实多入口、写语义不等价)。
 * 收口:本模块唯一 own 双写,两面板均消费;新增入口零分支获得完整写语义。
 *   petSettings 侧不可达(后端未起)=localStorage 仍已生效;返回 promise 交调用方呈现失败
 *   (诚实降级,本模块不吞错)。
 */
import { storage } from "./storage.mjs";
import { sendAction } from "../transport/sendAction.mjs";

/** 录音设备(空串=系统默认)。localStorage 立即生效,petSettings 镜像经 pet-settings 轮询数秒内达桌宠。 */
export function setSttRecordDevice(v) {
  storage.set("beilu-stt-record-device", String(v ?? ""));
  return sendAction({ verb: "setPetSettings", target: "server:eye", source: "web", payload: { sttDevice: v === "" || v == null ? null : Number(v) } });
}

/** 服务端降噪开关。 */
export function setSttServerDenoise(on) {
  storage.set("beilu-stt-server-denoise", String(!!on));
  return sendAction({ verb: "setPetSettings", target: "server:eye", source: "web", payload: { sttDenoise: !!on } });
}
