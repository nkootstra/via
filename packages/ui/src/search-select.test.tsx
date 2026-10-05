import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchSelect } from "./index.ts";

type Groups = ComponentProps<typeof SearchSelect>["groups"];

const groups: Groups = [
  {
    label: "Codex",
    icon: <svg data-testid="codex-icon" />,
    options: [
      { value: "gpt-6-luna", label: "gpt-6-luna", detail: "low · high" },
      {
        value: "gpt-6-mini",
        label: "gpt-6-mini",
        detail: "Needs a Pro plan",
        disabled: true,
      },
    ],
  },
  {
    label: "OpenRouter",
    options: [
      {
        value: "openrouter/kimi-k3",
        label: "kimi-k3",
        keywords: ["moonshot"],
      },
      { value: "openrouter/minimax-m3", label: "minimax-m3" },
    ],
  },
];

function Controlled({
  initial = null,
  onChange = () => {},
}: {
  readonly initial?: string | null;
  readonly onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);

  return (
    <SearchSelect
      label="Model"
      groups={groups}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      trigger={value ?? "Pick a model"}
      placeholder="Search models"
    />
  );
}

const optionNames = () =>
  within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((option) => option.textContent);

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("combobox", { name: /^Model/ }));

  return screen.findByRole("listbox");
};

describe("SearchSelect", () => {
  it("shows its trigger content, and names the trigger by its label and the choice", () => {
    render(<Controlled initial="openrouter/kimi-k3" />);

    const trigger = screen.getByRole("combobox", { name: "Model: kimi-k3" });

    expect(trigger.textContent).toBe("openrouter/kimi-k3");
  });

  it("names the trigger by its label alone while nothing is chosen", () => {
    render(<Controlled />);

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toBe("Pick a model");
  });

  it("lists each group under its label, as a group named by it", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await open(user);

    const codex = screen.getByRole("group", { name: "Codex" });
    const openRouter = screen.getByRole("group", { name: "OpenRouter" });

    expect(within(codex).getByTestId("codex-icon")).toBeDefined();
    expect(within(codex).getAllByRole("option")).toHaveLength(2);
    expect(within(openRouter).getAllByRole("option")).toHaveLength(2);
  });

  it("narrows the options by label as you type, and hides a group left empty", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await open(user);
    await user.keyboard("MINIMAX");

    await waitFor(() => expect(optionNames()).toEqual(["minimax-m3"]));
    expect(screen.queryByRole("group", { name: "Codex" })).toBeNull();
  });

  it("finds an option by one of its keywords", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await open(user);
    await user.keyboard("Moonshot");

    await waitFor(() => expect(optionNames()).toEqual(["kimi-k3"]));
  });

  it("says when nothing matches what was typed", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await open(user);
    await user.keyboard("llama");

    expect(await screen.findByText("No matches")).toBeDefined();
  });

  it("picks the highlighted option with the keyboard, closes, and gives focus back to the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    screen.getByRole("combobox", { name: "Model" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    await user.keyboard("kimi");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("openrouter/kimi-k3");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Model: kimi-k3" }));
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await open(user);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Model" }));
  });

  it("shows a disabled option's detail and won't pick it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    await open(user);
    const mini = screen.getByRole("option", { name: /gpt-6-mini/ });

    expect(mini.textContent).toContain("Needs a Pro plan");
    expect(mini.getAttribute("aria-disabled")).toBe("true");

    await user.click(mini);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows an option's detail beside its label", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await open(user);

    expect(screen.getByRole("option", { name: /gpt-6-luna/ }).textContent).toBe(
      "gpt-6-lunalow · high",
    );
  });

  it("works as an add picker: each pick calls back, and the trigger stays as given", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <SearchSelect
        label="Add a model"
        groups={groups}
        value={null}
        onValueChange={onAdd}
        trigger="Add model"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Add a model" }));
    await user.click(await screen.findByRole("option", { name: /kimi-k3/ }));
    await user.click(screen.getByRole("combobox", { name: "Add a model" }));
    await user.click(await screen.findByRole("option", { name: /minimax-m3/ }));

    expect(onAdd.mock.calls).toEqual([["openrouter/kimi-k3"], ["openrouter/minimax-m3"]]);
    expect(screen.getByRole("combobox", { name: "Add a model" }).textContent).toBe("Add model");
  });
});
