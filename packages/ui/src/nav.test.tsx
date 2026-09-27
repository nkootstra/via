import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NavItem, NavList } from "./index.ts";

describe("NavList", () => {
  it("is a named navigation landmark of links, marking the current page", () => {
    render(
      <NavList label="Pages">
        <NavItem
          label="Overview"
          current
          render={(props) => (
            <a href="/ui/" {...props}>
              {props.children}
            </a>
          )}
        />
        <NavItem
          label="Keys"
          current={false}
          render={(props) => (
            <a href="/ui/keys" {...props}>
              {props.children}
            </a>
          )}
        />
      </NavList>,
    );

    const nav = screen.getByRole("navigation", { name: "Pages" });
    const overview = within(nav).getByRole("link", { name: "Overview" });
    const keys = within(nav).getByRole("link", { name: "Keys" });
    expect(overview.getAttribute("aria-current")).toBe("page");
    expect(keys.getAttribute("aria-current")).toBeNull();
    expect(keys.getAttribute("href")).toBe("/ui/keys");
  });

  it("reaches every item from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <NavList label="Pages">
        <NavItem
          label="Overview"
          current
          render={(props) => (
            <a href="/ui/" {...props}>
              {props.children}
            </a>
          )}
        />
        <NavItem
          label="Keys"
          current={false}
          render={(props) => (
            <a href="/ui/keys" {...props}>
              {props.children}
            </a>
          )}
        />
      </NavList>,
    );

    await user.tab();
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Keys" }));
  });
});
