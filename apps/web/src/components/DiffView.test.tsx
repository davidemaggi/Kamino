// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView, type DiffViewApi } from "./DiffView.js";

afterEach(cleanup);
const labels = { mine: "Mine", incoming: "Incoming" };

describe("DiffView", () => {
  it("mounts CodeMirror, returns the merged text, cleans up on unmount", () => {
    const ref = createRef<DiffViewApi>();
    const { container, unmount } = render(
      <DiffView
        ref={ref}
        mine={"a\nb\n"}
        incoming={"a\nc\n"}
        layout="split"
        editable={false}
        labels={labels}
      />,
    );
    expect(container.querySelector(".cm-mergeView")).not.toBeNull();
    expect(ref.current?.getMerged()).toBe("a\nb\n");
    unmount();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("unified layout", () => {
    const { container } = render(
      <DiffView mine="a" incoming="b" layout="unified" editable labels={labels} />,
    );
    expect(container.querySelector(".diff-view--unified .cm-editor")).not.toBeNull();
  });
});
