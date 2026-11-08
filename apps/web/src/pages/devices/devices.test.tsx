// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../../mocks/db.js";
import { ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("Devices", () => {
  it("list shows every device; revoked ones are marked", async () => {
    signInAs("demo");
    await renderRoute("/devices");
    expect(await screen.findByText("MacBook")).toBeDefined();
    expect(screen.getByText("Vecchio portatile")).toBeDefined();
    expect(screen.getAllByText("Revocato").length).toBeGreaterThan(0);
  });

  it("detail shows D-06 fields, renames and revokes with confirmation", async () => {
    signInAs("demo");
    await renderRoute("/devices/d-iphone");
    expect(await screen.findByText("14 modifiche indietro")).toBeDefined();
    expect(screen.getByText("iOS")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Nome", { selector: "input" }), {
      target: { value: "iPhone 15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    await waitFor(() =>
      expect(ud.devices.find((d) => d.id === "d-iphone")!.name).toBe("iPhone 15"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoca il dispositivo" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/non vengono cancellati/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoca" }));
    await waitFor(() => expect(ud.devices.find((d) => d.id === "d-iphone")!.revoked).toBe(true));
  });
});
