import {
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
import { request, requestVoid } from "./http.js";

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
};
