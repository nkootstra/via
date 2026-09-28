import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MenuItem,
  NavItem,
  NavList,
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  SidebarUserMenu,
} from "./index.ts";

// happy-dom's handle on its window, which its viewport is resized through.
declare global {
  interface Window {
    readonly happyDOM?: {
      readonly setViewport: (viewport: { width: number; height: number }) => void;
    };
  }
}

const setWidth = (width: number) => {
  act(() => {
    window.happyDOM?.setViewport({ width, height: 800 });
  });
};

afterEach(() => {
  localStorage.clear();
  setWidth(1024);
});

function Shell() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <NavList label="Pages">
            <NavItem
              label="Overview"
              current
              render={(props) => (
                <a href="#overview" {...props}>
                  {props.children}
                </a>
              )}
            />
          </NavList>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
        <input aria-label="Search" />
      </SidebarInset>
    </SidebarProvider>
  );
}

// An open drawer is modal, so the page behind it, trigger included, is hidden.
const trigger = () => screen.getByRole("button", { name: /^(Hide|Show) sidebar$/, hidden: true });

/** How many shapes the trigger's glyph draws: the hide glyph two, the show glyph one. */
const glyphPaths = () => trigger().querySelectorAll("svg path").length;

/** The pinned panel's page links, which a collapsed sidebar takes out of reach. */
const reachableLinks = () => screen.queryAllByRole("link", { name: "Overview" });

describe("Sidebar", () => {
  it("starts open, its trigger saying so and naming the panel it controls", () => {
    render(<Shell />);

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(trigger().getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(within(panel ?? document.body).getByRole("link", { name: "Overview" })).toBeDefined();
    expect(reachableLinks()).toHaveLength(1);
  });

  it("names and draws its trigger for what a press does next", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    expect(trigger().getAttribute("aria-label")).toBe("Hide sidebar");
    expect(glyphPaths()).toBe(2);

    await user.click(trigger());

    expect(trigger().getAttribute("aria-label")).toBe("Show sidebar");
    expect(glyphPaths()).toBe(1);
  });

  it("collapses and expands from its trigger, out of reach while collapsed", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(reachableLinks()).toHaveLength(0);

    await user.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(reachableLinks()).toHaveLength(1);
  });

  it("remembers being collapsed for the next visit", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Shell />);
    await user.click(trigger());
    unmount();

    render(<Shell />);

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles on [, except while typing or with a modifier held", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.keyboard("[[");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("{Meta>}[[{/Meta}");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByRole("textbox", { name: "Search" }));
    await user.keyboard("[[");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await user.click(document.body);
    await user.keyboard("[[");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("stays collapsed under a resting pointer, coming back only when asked", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(trigger());

    await user.hover(trigger());
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(screen.queryByRole("button", { name: "Peek sidebar" })).toBeNull();
    expect(reachableLinks()).toHaveLength(0);
  });

  describe("on a narrow screen", () => {
    it("is a closed drawer that the trigger opens, and Escape closes", async () => {
      setWidth(390);
      const user = userEvent.setup();
      render(<Shell />);

      expect(reachableLinks()).toHaveLength(0);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(trigger().getAttribute("aria-label")).toBe("Show sidebar");
      expect(glyphPaths()).toBe(1);

      await user.click(trigger());

      const drawer = screen.getByRole("dialog", { name: "Sidebar" });
      expect(within(drawer).getByRole("link", { name: "Overview" })).toBeDefined();
      expect(trigger().getAttribute("aria-expanded")).toBe("true");

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("closes once a link in it is followed", async () => {
      setWidth(390);
      const user = userEvent.setup();
      render(<Shell />);
      await user.click(trigger());

      await user.click(
        within(screen.getByRole("dialog", { name: "Sidebar" })).getByRole("link", {
          name: "Overview",
        }),
      );

      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("doesn't carry a collapsed wide sidebar into the drawer's state", async () => {
      const user = userEvent.setup();
      render(<Shell />);
      await user.click(trigger());

      setWidth(390);

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(localStorage.getItem("via.sidebar")).toBe("collapsed");
    });
  });

  describe("the user menu", () => {
    it("is a row naming the user that opens their menu, and gives focus back", async () => {
      const user = userEvent.setup();
      const onSignOut = vi.fn();
      render(
        <SidebarProvider>
          <Sidebar>
            <SidebarUserMenu name="Admin">
              <MenuItem label="Sign out" onClick={onSignOut} />
            </SidebarUserMenu>
          </Sidebar>
        </SidebarProvider>,
      );

      const row = screen.getByRole("button", { name: "Admin" });
      expect(row.getAttribute("aria-haspopup")).toBe("menu");
      expect(row.getAttribute("aria-expanded")).toBe("false");

      await user.click(row);

      expect(row.getAttribute("aria-expanded")).toBe("true");
      await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      expect(onSignOut).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(document.activeElement).toBe(row);
    });
  });
});
