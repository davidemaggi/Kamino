import {
  ConflictDetail,
  ConflictList,
  Device,
  DeviceList,
  FileList,
  FileVersions,
  PairingOffer,
  PairingState,
  ResolveAllResponse,
  TrashList,
  Vault,
  VaultList,
  VersionContent,
  type BulkStrategy,
  type Resolution,
  type VaultPatch,
  ForgotResponse,
  InviteInfo,
  LoginResponse,
  Me,
  RecoveryCodes,
  SecurityLogPage,
  SessionList,
  SetupStatus,
  TotpSetupInfo,
  VaultsSummary,
  type ProfilePatch,
  type SetupRequest,
} from "@kamino/protocol";
import { request, requestBlob, requestVoid } from "./http.js";

/** One function per route of the contract (spec §3). */
export const api = {
  setupStatus: () => request(SetupStatus, "/setup/status"),
  setup: (body: SetupRequest) => request(Me, "/setup", { method: "POST", body }),
  login: (username: string, password: string) =>
    request(LoginResponse, "/auth/login", { method: "POST", body: { username, password } }),
  loginTotp: (challengeId: string, code: string) =>
    request(Me, "/auth/totp", { method: "POST", body: { challengeId, code } }),
  logout: () => requestVoid("/auth/logout", { method: "POST" }),
  me: () => request(Me, "/me"),
  forgot: (email: string) =>
    request(ForgotResponse, "/auth/forgot", { method: "POST", body: { email } }),
  reset: (token: string, password: string) =>
    requestVoid("/auth/reset", { method: "POST", body: { token, password } }),
  invite: (token: string) => request(InviteInfo, `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) =>
    request(Me, `/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body: { password },
    }),
  updateProfile: (body: ProfilePatch) => request(Me, "/account/profile", { method: "PATCH", body }),
  changePassword: (current: string, next: string) =>
    requestVoid("/account/password", { method: "POST", body: { current, next } }),
  totpSetup: () => request(TotpSetupInfo, "/account/totp/setup", { method: "POST" }),
  totpConfirm: (code: string) =>
    request(RecoveryCodes, "/account/totp/confirm", { method: "POST", body: { code } }),
  totpDisable: (password: string) =>
    requestVoid("/account/totp/disable", { method: "POST", body: { password } }),
  regenerateRecoveryCodes: (password: string) =>
    request(RecoveryCodes, "/account/totp/recovery-codes", { method: "POST", body: { password } }),
  sessions: () => request(SessionList, "/account/sessions"),
  endSession: (id: string) =>
    requestVoid(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  endOtherSessions: () => requestVoid("/account/sessions", { method: "DELETE" }),
  securityLog: (page: number) => request(SecurityLogPage, `/account/security-log?page=${page}`),
  vaultsSummary: () => request(VaultsSummary, "/vaults/summary"),
  vaults: () => request(VaultList, "/vaults"),
  vault: (id: string) => request(Vault, `/vaults/${encodeURIComponent(id)}`),
  updateVault: (id: string, body: VaultPatch) =>
    request(Vault, `/vaults/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  deleteVault: (id: string, confirmName: string) =>
    requestVoid(`/vaults/${encodeURIComponent(id)}`, { method: "DELETE", body: { confirmName } }),
  downloadZip: (id: string, at?: string) =>
    requestBlob(
      `/vaults/${encodeURIComponent(id)}/zip${at ? `?at=${encodeURIComponent(at)}` : ""}`,
    ),
  devices: () => request(DeviceList, "/devices"),
  device: (id: string) => request(Device, `/devices/${encodeURIComponent(id)}`),
  renameDevice: (id: string, name: string) =>
    request(Device, `/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  revokeDevice: (id: string) =>
    request(Device, `/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  startPairing: (vaultId: string) =>
    request(PairingOffer, `/vaults/${encodeURIComponent(vaultId)}/pairings`, { method: "POST" }),
  pairing: (id: string) => request(PairingState, `/pairings/${encodeURIComponent(id)}`),
  approvePairing: (id: string) =>
    requestVoid(`/pairings/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  denyPairing: (id: string) =>
    requestVoid(`/pairings/${encodeURIComponent(id)}/deny`, { method: "POST" }),
  cancelPairing: (id: string) =>
    requestVoid(`/pairings/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  conflicts: () => request(ConflictList, "/conflicts"),
  conflict: (id: string) => request(ConflictDetail, `/conflicts/${encodeURIComponent(id)}`),
  resolveConflict: (id: string, resolution: Resolution, expectedIncomingAt: string) =>
    requestVoid(`/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: { resolution, expectedIncomingAt },
    }),
  resolveAll: (strategy: BulkStrategy, ids: string[]) =>
    request(ResolveAllResponse, "/conflicts/resolve-all", {
      method: "POST",
      body: { strategy, ids },
    }),
  files: (vaultId: string, q: string) =>
    request(FileList, `/vaults/${encodeURIComponent(vaultId)}/files?q=${encodeURIComponent(q)}`),
  fileVersions: (fileId: string) =>
    request(FileVersions, `/files/${encodeURIComponent(fileId)}/versions`),
  version: (id: string) => request(VersionContent, `/versions/${encodeURIComponent(id)}`),
  restoreVersion: (id: string) =>
    requestVoid(`/versions/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  trash: (vaultId: string) => request(TrashList, `/vaults/${encodeURIComponent(vaultId)}/trash`),
  restoreTrash: (fileId: string) =>
    requestVoid(`/trash/${encodeURIComponent(fileId)}/restore`, { method: "POST" }),
};
