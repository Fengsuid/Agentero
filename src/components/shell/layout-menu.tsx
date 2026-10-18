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
	const selected = value === "custom" ? "" : value;

	const cancelClose = () => window.clearTimeout(closeTimer.current);
	const scheduleClose = () => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => setOpen(false), 150);
	};

	useEffect(() => () => window.clearTimeout(closeTimer.current), []);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("titlebar.layout")}
					onMouseEnter={() => {
						cancelClose();
						setOpen(true);
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
