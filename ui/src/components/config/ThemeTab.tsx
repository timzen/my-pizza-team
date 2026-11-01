/**
 * ThemeTab — Config → Theme (`/config/theme`): the UI palette.
 *
 * Client-side preference (localStorage + the data-theme attribute on <html>),
 * applied immediately — not part of the daemon config, so no Save button.
 * Light/dark mode stays on the NavBar toggle; this picks the palette.
 */

import { useState } from "react";
import { SegmentedTabs } from "@/components/RouteTabs";
import { PALETTES, getStoredPalette, applyPalette } from "@/lib/theme";
import { Card, CardContent } from "@/components/ui/card";

/** The palette picker (applies and remembers the choice at once). */
export function ThemeTab() {
  const [palette, setPalette] = useState(getStoredPalette);

  const select = (key: string | null) => {
    const value = key ?? "";
    setPalette(value);
    applyPalette(value);
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Palette</h2>
        <p className="text-xs text-muted-foreground">
          Colors for the whole UI, in both light and dark mode (use the sun/moon toggle in the
          top bar to switch modes). Applied immediately and remembered in this browser.
        </p>
        <SegmentedTabs
          tabs={PALETTES.map(p => ({ key: p.value, label: p.label }))}
          active={palette}
          onSelect={select}
        />
      </CardContent>
    </Card>
  );
}
