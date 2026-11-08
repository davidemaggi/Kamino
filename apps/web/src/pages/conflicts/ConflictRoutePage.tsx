import { useParams } from "@tanstack/react-router";
import { ConflictCenter } from "./ConflictCenter.js";

export function ConflictRoutePage() {
  const { conflictId } = useParams({ from: "/app/conflicts/$conflictId" });
  return <ConflictCenter selectedId={conflictId} />;
}
