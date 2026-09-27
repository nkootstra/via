import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TabItem, TabPanel, Tabs, TabsList } from "./index.ts";

function Pages({ onValueChange }: { readonly onValueChange?: (value: string) => void }) {
  return (
    <Tabs defaultValue="accounts" {...(onValueChange === undefined ? {} : { onValueChange })}>
      <TabsList aria-label="Pages">
        <TabItem value="accounts" label="Accounts" />
        <TabItem value="keys" label="Keys" />
        <TabItem value="usage" label="Usage" />
      </TabsList>
      <TabPanel value="accounts">Account list</TabPanel>
      <TabPanel value="keys">Key list</TabPanel>
      <TabPanel value="usage">Usage chart</TabPanel>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("is a tablist whose selected tab labels the visible panel", () => {
    render(<Pages />);

    expect(screen.getByRole("tablist", { name: "Pages" })).toBeDefined();
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected.textContent).toContain("Accounts");
    expect(screen.getByRole("tabpanel", { name: "Accounts" }).textContent).toBe("Account list");
  });

  it("names each tab once, though the label is drawn twice to hold its width", () => {
    render(<Pages />);

    for (const name of ["Accounts", "Keys", "Usage"]) {
      expect(screen.getByRole("tab", { name })).toBeDefined();
    }
  });

  it("moves and selects with the arrow keys", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Pages onValueChange={onValueChange} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Accounts" }));
    await user.keyboard("{ArrowRight}");

    const keys = screen.getByRole("tab", { name: "Keys" });
    expect(document.activeElement).toBe(keys);
    expect(keys.getAttribute("aria-selected")).toBe("true");
    expect(onValueChange).toHaveBeenLastCalledWith("keys");
    expect(screen.getByRole("tabpanel").textContent).toBe("Key list");
  });

  it("selects on click", async () => {
    const user = userEvent.setup();
    render(<Pages />);

    await user.click(screen.getByRole("tab", { name: "Usage" }));

    expect(screen.getByRole("tabpanel", { name: "Usage" }).textContent).toBe("Usage chart");
  });
});
