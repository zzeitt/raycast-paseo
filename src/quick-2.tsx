import { LaunchProps } from "@raycast/api";
import QuickSlot from "./components/quick-slot";

type QuickProps = LaunchProps<{ arguments: { argument?: string } }>;

export default function Command(props: QuickProps) {
  return <QuickSlot slot={2} argumentArg={props.arguments.argument} />;
}
