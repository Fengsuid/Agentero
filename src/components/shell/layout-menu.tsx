import { PanelsTopLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LayoutMode } from "@/lib/shell/ui-store";

type LayoutMenuProps = {
	value: LayoutMode;
	onValueChange: (mode: Exclude<LayoutMode, "custom">) => void;
};

/** Title-bar menu for the three paper-reading workbench presets. */
export function LayoutMenu({ value, onValueChange }: LayoutMenuProps) {
	const { t } = useTranslation("app");
	const [open, setOpen] = useState(false);
	const closeTimer = useRef<number | undefined>(undefined);
	/** Clicked open: hover-out must not dismiss it; outside click still does. */
	const pinned = useRef(false);
	/** Hover opened the menu first; the first click pins instead of closing. */
	const suppressNextClose = useRef(false);
	const selected = value === "custom" ? "" : value;

	const cancelClose = () => window.clearTimeout(closeTimer.current);
	const scheduleClose = () => {
		cancelClose();
		if (pinned.current) return;
		closeTimer.current = window.setTimeout(() => setOpen(false), 150);
	};

	const handlePointerDownCapture = () => {
		if (open && !pinned.current) {
			// The menu is already visible from hover: a click pins it open so
			// the pointerdown toggle does not make it flicker closed.
			pinned.current = true;
			suppressNextClose.current = true;
			window.setTimeout(() => {
				suppressNextClose.current = false;
			}, 0);
			return;
		}
		pinned.current = true;
	};

	const handleOpenChange = (next: boolean) => {
		if (!next && suppressNextClose.current) {
			suppressNextClose.current = false;
			return;
		}
		if (!next) pinned.current = false;
		setOpen(next);
	};

	useEffect(() => () => window.clearTimeout(closeTimer.current), []);

	return (
		<DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("titlebar.layout")}
					className="transition-transform active:scale-95 data-[state=open]:bg-muted data-[state=open]:text-foreground"
					onPointerDownCapture={handlePointerDownCapture}
					onMouseEnter={() => {
						cancelClose();
						if (!open) {
							pinned.current = false;
							setOpen(true);
						}
					}}
					onMouseLeave={scheduleClose}
				>
					<PanelsTopLeft className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-48"
				onMouseEnter={cancelClose}
				onMouseLeave={scheduleClose}
			>
				<DropdownMenuLabel>{t("titlebar.layoutModes")}</DropdownMenuLabel>
				{/*
				 * Use `onSelect` rather than the group's `onValueChange`: the
				 * controlled value is empty in custom mode, so re-selecting the
				 * current preset (or toggling Reading off) must still fire.
				 */}
				<DropdownMenuRadioGroup value={selected}>
					<DropdownMenuRadioItem
						value="agent"
						onSelect={() => onValueChange("agent")}
					>
						{t("titlebar.layoutAgent")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						value="notes"
						onSelect={() => onValueChange("notes")}
					>
						{t("titlebar.layoutNotes")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						value="reading"
						onSelect={() => onValueChange("reading")}
					>
						{t("titlebar.layoutReading")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
