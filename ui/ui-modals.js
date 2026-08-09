const showToast = (message, type = "error") => {
	const container = document.getElementById("toastContainer");
	if (!container) return;

	const isMiniOrCinema =
		document.body.classList.contains("mini-player") ||
		document.body.classList.contains("cinema-active");

	// Explicitly force position and strip margin auto overrides using cssText
	container.className = `fixed z-[9999] flex flex-col gap-2 w-full max-w-md pointer-events-none px-4 ${isMiniOrCinema ? "items-center" : "items-end"}`;

	if (isMiniOrCinema) {
		container.style.cssText =
			"top: 1rem !important; bottom: auto !important; left: 50% !important; right: auto !important; transform: translateX(-50%) !important; margin: 0 !important;";
	} else {
		container.style.cssText =
			"top: auto !important; bottom: 1.5rem !important; left: auto !important; right: 1.5rem !important; transform: none !important; margin: 0 !important;";
	}

	const toast = document.createElement("div");
	const baseClasses =
		"flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border text-sm font-medium transition-all duration-300 pointer-events-auto cursor-pointer max-w-md w-full opacity-0";

	const typeClasses =
		type === "error"
			? "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-400"
			: type === "success"
				? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-400"
				: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20 dark:text-blue-400";

	toast.className = `${baseClasses} ${typeClasses}`;

	// Set initial offscreen transforms depending on mode
	if (isMiniOrCinema) {
		toast.style.transform = "translateY(-150%)"; // Slide down from top
	} else {
		toast.style.transform = "translateX(120%)"; // Slide in from right
	}

	const icon =
		type === "error"
			? `<svg class="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`
			: type === "success"
				? `<svg class="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>`
				: `<svg class="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;

	toast.innerHTML = icon;
	const span = document.createElement("span");
	span.textContent = message;
	toast.appendChild(span);
	container.appendChild(toast);

	const dismiss = () => {
		toast.style.opacity = "0";
		if (isMiniOrCinema) {
			toast.style.transform = "translateY(-150%)";
		} else {
			toast.style.transform = "translateX(120%)"; // Exit right
		}
		setTimeout(() => {
			if (container.contains(toast)) container.removeChild(toast);
		}, 300);
	};

	// Click to dismiss early
	toast.addEventListener("click", dismiss);

	// Trigger entrance transition
	requestAnimationFrame(() => {
		toast.style.opacity = "1";
		if (isMiniOrCinema) {
			toast.style.transform = "translateY(0)";
		} else {
			toast.style.transform = "translateX(0)";
		}
	});

	setTimeout(dismiss, 4000);
};

// Intercept native alerts to use our sleek Toast system
window.alert = (message) => showToast(message, "error");

/**
 * App confirm dialog.
 * @param {string} message
 * @param {string} [title="Confirm"]
 * @param {{
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   danger?: boolean,
 *   focusCancel?: boolean,
 * }} [opts]
 * @returns {Promise<boolean>}
 */
const asyncConfirm = (message, title = "Confirm", opts = {}) => {
	const {
		confirmLabel = "Confirm",
		cancelLabel = "Cancel",
		danger = false,
		focusCancel = false,
	} = opts && typeof opts === "object" ? opts : {};

	return new Promise((resolve) => {
		const modal = document.getElementById("confirmModal");
		const titleEl = document.getElementById("confirmTitle");
		const messageEl = document.getElementById("confirmMessage");
		const btnOk = document.getElementById("confirmOkBtn");
		const btnCancel = document.getElementById("confirmCancelBtn");
		if (!modal || !btnOk || !btnCancel) {
			resolve(false);
			return;
		}

		if (titleEl) titleEl.textContent = title;
		if (messageEl) messageEl.textContent = message;

		btnOk.textContent = confirmLabel;
		btnCancel.textContent = cancelLabel;
		// Primary right, cancel left (HTML order). Destructive uses danger styling.
		btnOk.className = danger
			? "btn btn-danger shrink-0"
			: "btn btn-primary shrink-0";
		btnCancel.className = "btn btn-outline-secondary shrink-0";

		let resolved = false;

		const cleanup = () => {
			btnOk.removeEventListener("click", onOk);
			btnCancel.removeEventListener("click", onCancel);
			modal.removeEventListener("cancel", onDialogCancel);
			if (modal.open) modal.close();
		};

		const finish = (value) => {
			if (resolved) return;
			resolved = true;
			cleanup();
			resolve(value);
		};

		const onOk = () => finish(true);
		const onCancel = () => finish(false);
		// Esc / dialog cancel → safest path (cancel)
		const onDialogCancel = (e) => {
			e.preventDefault();
			finish(false);
		};

		btnOk.addEventListener("click", onOk);
		btnCancel.addEventListener("click", onCancel);
		modal.addEventListener("cancel", onDialogCancel);
		modal.showModal();
		if (focusCancel) btnCancel.focus();
		else btnOk.focus();
	});
};

/**
 * App prompt dialog.
 * @param {string} message
 * @param {string} [defaultValue=""]
 * @param {string} [title="Input"]
 * @param {string[]} [suggestions=[]]
 * @param {{
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 * }} [opts]
 * @returns {Promise<string|null>}
 */
const asyncPrompt = (
	message,
	defaultValue = "",
	title = "Input",
	suggestions = [],
	opts = {},
) => {
	const { confirmLabel = "OK", cancelLabel = "Cancel" } =
		opts && typeof opts === "object" ? opts : {};

	return new Promise((resolve) => {
		const modal = document.getElementById("promptModal");
		const titleEl = document.getElementById("promptTitle");
		const messageEl = document.getElementById("promptMessage");
		const input = document.getElementById("promptInput");
		const btnOk = document.getElementById("promptOkBtn");
		const btnCancel = document.getElementById("promptCancelBtn");
		if (!modal || !input || !btnOk || !btnCancel) {
			resolve(null);
			return;
		}

		if (titleEl) titleEl.textContent = title;
		if (messageEl) {
			messageEl.textContent = message;
			messageEl.classList.toggle("hidden", !message);
		}
		input.value = defaultValue ?? "";

		const datalist = document.getElementById("promptDatalist");
		if (datalist) {
			datalist.innerHTML = "";
			if (suggestions && suggestions.length > 0) {
				const uniqueSuggestions = [...new Set(suggestions)].filter(Boolean);
				for (const suggestion of uniqueSuggestions) {
					const option = document.createElement("option");
					option.value = suggestion;
					datalist.appendChild(option);
				}
				input.setAttribute("list", "promptDatalist");
			} else {
				input.removeAttribute("list");
			}
		}

		btnOk.textContent = confirmLabel;
		btnCancel.textContent = cancelLabel;
		btnOk.className = "btn btn-primary shrink-0";
		btnCancel.className = "btn btn-outline-secondary shrink-0";

		let resolved = false;

		const cleanup = () => {
			btnOk.removeEventListener("click", onOk);
			btnCancel.removeEventListener("click", onCancel);
			input.removeEventListener("keydown", onKeydown);
			modal.removeEventListener("cancel", onDialogCancel);
			if (modal.open) modal.close();
		};

		const finish = (value) => {
			if (resolved) return;
			resolved = true;
			cleanup();
			resolve(value);
		};

		const onOk = () => finish(input.value);
		const onCancel = () => finish(null);
		const onDialogCancel = (e) => {
			e.preventDefault();
			finish(null);
		};
		const onKeydown = (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				onOk();
			} else if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
			}
		};

		btnOk.addEventListener("click", onOk);
		btnCancel.addEventListener("click", onCancel);
		input.addEventListener("keydown", onKeydown);
		modal.addEventListener("cancel", onDialogCancel);
		modal.showModal();
		input.focus();
		input.select();
	});
};

window.showToast = showToast;
window.asyncConfirm = asyncConfirm;
window.asyncPrompt = asyncPrompt;
