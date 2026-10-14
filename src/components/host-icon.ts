import { Color, Icon } from "@raycast/api";
import type { HostRow } from "../paseo/hosts";

/**
 * Paseo names a host's colour after the Tailwind palette it themes with; Raycast has a smaller set
 * of its own. Names without a counterpart are left uncoloured rather than guessed at.
 */
const HOST_COLOR: Record<string, Color> = {
  red: Color.Red,
  rose: Color.Red,
  orange: Color.Orange,
  amber: Color.Orange,
  yellow: Color.Yellow,
  lime: Color.Green,
  green: Color.Green,
  emerald: Color.Green,
  teal: Color.Green,
  cyan: Color.Blue,
  sky: Color.Blue,
  blue: Color.Blue,
  indigo: Color.Blue,
  violet: Color.Purple,
  purple: Color.Purple,
  fuchsia: Color.Magenta,
  pink: Color.Magenta,
};

export function hostTint(host: HostRow): Color | undefined {
  return host.color ? HOST_COLOR[host.color.toLowerCase()] : undefined;
}

/** The host as a coloured dot, for the places that only have room for an icon. */
export function hostIcon(host: HostRow): { source: Icon; tintColor: Color } {
  return { source: Icon.CircleFilled, tintColor: hostTint(host) ?? Color.SecondaryText };
}
