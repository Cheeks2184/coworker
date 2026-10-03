// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Coworker } from "@shared/contracts";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderSettings(savedKeys: string[], integrations: Record<string, unknown>, coworkers: Coworker[] = []) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: {
      app: { updateSettings: vi.fn() },
      diagnostics: { listProviderErrors: vi.fn().mockResolvedValue([]) },
      integrations: {
        credentialStatus: vi.fn(async (key: string) => ({
          key,
          configured: savedKeys.includes(key),
          needsReentry: false,
        })),
        listModels: vi.fn().mockResolvedValue([]),
        ...integrations,
      },
    },
  });
  render(
    <SettingsPage
      coworkers={coworkers}
      dataPath="/tmp/coworker-data"
      integrations={[]}
      onChanged={onChanged}
      settings={{
        demoMode: false,
        launchAtLogin: false,
        runInBackground: true,
        theme: "forest",
        colorMode: "light",
        showReasoning: true,
        globalOperatingInstructions: "",
        defaultModelProvider: "openrouter",
        defaultModelName: "vendor/model",
      }}
      skills={[]}
    />,
  );
  return { onChanged };
}

describe("removing saved provider keys", () => {
  it("shows a saved model key and disconnects the provider from a confirmation dialog", async () => {
    const disconnectModel = vi.fn().mockResolvedValue(undefined);
    const ava = { id: "ava", name: "Ava", modelProvider: "openrouter" } as Coworker;
    const { onChanged } = renderSettings(["model:openrouter"], { disconnectModel }, [ava]);

    fireEvent.click(screen.getByRole("button", { name: "Model Providers" }));
    expect(screen.getByRole("heading", { name: "Model Providers" })).toBeTruthy();
    await screen.findByRole("button", { name: "OpenRouter Connected · Default" });
    expect(screen.getByText("API key saved")).toBeTruthy();

    // Cancelling keeps everything as it was.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(disconnectModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect OpenRouter?" });
    expect(dialog.textContent).toContain("Its saved API key is removed from this computer.");
    expect(dialog.textContent).toContain(
      "Ava will stop working until you reconnect OpenRouter or give them another model.",
    );
    expect(dialog.textContent).toContain("OpenRouter will no longer be the global default model.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(disconnectModel).toHaveBeenCalledWith("openrouter");
    await screen.findByRole("button", { name: "OpenRouter Not connected · Default" });
    expect(screen.queryByText("API key saved")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("OpenRouter was disconnected.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when disconnecting fails", async () => {
    const disconnectModel = vi
      .fn()
      .mockRejectedValue(
        new Error("Error invoking remote method 'coworker:integrations:disconnect-model': Error: Storage is locked"),
      );
    renderSettings(["model:openrouter"], { disconnectModel });
    fireEvent.click(screen.getByRole("button", { name: "Model Providers" }));
    await screen.findByText("API key saved");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    expect(await within(dialog).findByText("Storage is locked")).toBeTruthy();
    expect(screen.getByText("API key saved")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("only offers to disconnect providers that are connected", async () => {
    renderSettings([], {});
    fireEvent.click(screen.getByRole("button", { name: "Model Providers" }));
    await screen.findByRole("button", { name: "OpenRouter Not connected · Default" });
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("starts on Firecrawl, shows its saved key and removes it, falling back to the free tier", async () => {
    const disconnectWebSearch = vi.fn().mockResolvedValue(undefined);
    renderSettings(["web-search:firecrawl"], { disconnectWebSearch });

    fireEvent.click(screen.getByRole("button", { name: "Web search" }));
    const firecrawl = await screen.findByRole("button", { name: "Firecrawl Connected" });
    expect(firecrawl.getAttribute("aria-pressed")).toBe("true");
    expect(firecrawl.parentElement?.firstElementChild).toBe(firecrawl);
    expect(screen.getByText("API key saved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove the Firecrawl key?" });
    expect(dialog.textContent).toContain("Web search will use Firecrawl's free tier, which has a daily limit.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(disconnectWebSearch).toHaveBeenCalledWith("firecrawl"));
    await screen.findByRole("button", { name: "Firecrawl Not connected" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Firecrawl key removed. Web search now uses Firecrawl's free tier.",
    );
  });

  it("clears the confirmation after a few seconds, or right away on another tab", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const disconnectWebSearch = vi.fn().mockResolvedValue(undefined);
    renderSettings(["web-search:firecrawl", "web-search:tavily"], { disconnectWebSearch });
    const removeKey = async (card: string) => {
      fireEvent.click(await screen.findByRole("button", { name: card }));
      fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove key" }));
      await screen.findByRole("status");
    };
    fireEvent.click(screen.getByRole("button", { name: "Web search" }));

    await removeKey("Firecrawl Connected");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByRole("status")).toBeNull();

    await removeKey("Tavily Connected");
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("heading", { name: "General Settings" })).toBeTruthy();
  });

  it("keeps using the other saved search key after removing one", async () => {
    const disconnectWebSearch = vi.fn().mockResolvedValue(undefined);
    renderSettings(["web-search:firecrawl", "web-search:tavily"], { disconnectWebSearch });

    fireEvent.click(screen.getByRole("button", { name: "Web search" }));
    await screen.findByRole("button", { name: "Firecrawl Connected" });
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove the Firecrawl key?" });
    expect(dialog.textContent).toContain("Web search keeps working with your other saved key.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Firecrawl key removed."));
  });
});
