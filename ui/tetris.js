(() => {
	const CANVAS_WIDTH = 200;
	const CANVAS_HEIGHT = 400;
	const COLS = 10;
	const ROWS = 20;
	const BLOCK_SIZE = 20;

	const COLORS = [
		null,
		"#06b6d4", // 1: I (cyan)
		"#3b82f6", // 2: J (blue)
		"#f97316", // 3: L (orange)
		"#eab308", // 4: O (yellow)
		"#22c55e", // 5: S (green)
		"#a855f7", // 6: T (purple)
		"#ef4444", // 7: Z (red)
		"#71717a", // 8: Garbage (gray)
	];

	const TETROMINOES = {
		I: [
			[0, 0, 0, 0],
			[1, 1, 1, 1],
			[0, 0, 0, 0],
			[0, 0, 0, 0],
		],
		J: [
			[2, 0, 0],
			[2, 2, 2],
			[0, 0, 0],
		],
		L: [
			[0, 0, 3],
			[3, 3, 3],
			[0, 0, 0],
		],
		O: [
			[4, 4],
			[4, 4],
		],
		S: [
			[0, 5, 5],
			[5, 5, 0],
			[0, 0, 0],
		],
		T: [
			[0, 6, 0],
			[6, 6, 6],
			[0, 0, 0],
		],
		Z: [
			[7, 7, 0],
			[0, 7, 7],
			[0, 0, 0],
		],
	};

	let canvas;
	let ctx;
	let nextCanvas;
	let nextCtx;
	let board;
	let score;
	let highScore;
	let activePiece;
	let nextPiece;
	let isGameOver;
	let isPaused;
	let isBossKeyHidden;
	let dropCounter;
	let dropInterval;
	let lastTime;
	let animationFrameId;
	let isProcessingComplete;
	const triggeredMilestones = new Set();

	// Helper: pad scores with leading zeros
	const padScore = (num) => String(num).padStart(5, "0");

	const exitSecretGameUI = () => {
		if (typeof toggleSettings === "function") {
			toggleSettings(false);
		}
		if (typeof window.resetTrimModalUI === "function") {
			window.resetTrimModalUI();
		}
	};

	// Helper: Get high score from localStorage
	const loadHighScore = () => {
		const saved = localStorage.getItem("tetrisHighScore");
		highScore = saved ? Number.parseInt(saved, 10) : 0;
		if (Number.isNaN(highScore)) highScore = 0;
	};

	// Helper: Save high score to localStorage
	const saveHighScore = () => {
		if (score > highScore) {
			highScore = score;
			localStorage.setItem("tetrisHighScore", String(highScore));
			updateHeaderScore();
		}
	};

	const updateHeaderScore = () => {
		const display = document.getElementById("tetrisHighScoreDisplay");
		if (display) {
			display.textContent = `HS:${padScore(highScore)}`;
			if (highScore > 0) {
				display.classList.remove("hidden");
			} else {
				display.classList.add("hidden");
			}
		}
		const scoreLabel = document.getElementById("tetrisHighScore");
		if (scoreLabel) {
			scoreLabel.textContent = padScore(highScore);
		}
	};

	// Initial setup at boot
	document.addEventListener("DOMContentLoaded", () => {
		loadHighScore();
		updateHeaderScore();

		// Hook up double-click to progress container
		const progressContainer = document.getElementById("trimProgressContainer");
		if (progressContainer) {
			progressContainer.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				activateTetris();
			});
		}

		// Set up boss key listener globally
		window.addEventListener("keydown", (e) => {
			if (e.key === "b" || e.key === "B") {
				const panel = document.getElementById("settingsPanel");
				const isOpen = panel && !panel.classList.contains("translate-x-full");
				if (
					isOpen &&
					(document.getElementById("tetrisContainer").style.display !==
						"none" ||
						isBossKeyHidden)
				) {
					e.preventDefault();
					toggleBossKey();
				}
			}
		});
	});

	const activateTetris = () => {
		document.getElementById("trimNormalContent").classList.add("hidden");
		document.getElementById("trimNormalFooter").classList.add("hidden");
		const container = document.getElementById("tetrisContainer");
		container.classList.remove("hidden");
		container.style.display = "flex";

		canvas = document.getElementById("tetrisCanvas");
		ctx = canvas.getContext("2d");

		nextCanvas = document.getElementById("tetrisNextCanvas");
		nextCtx = nextCanvas.getContext("2d");

		// Start game state
		document.activeElement?.blur();
		window.addEventListener("keydown", handleInput);
		isPaused = false;
		isBossKeyHidden = false;
		isProcessingComplete = false;
		triggeredMilestones.clear();

		resetGame();
	};
	window.activateTetris = activateTetris;

	const resetGame = () => {
		cancelAnimationFrame(animationFrameId);
		board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
		score = 0;
		isGameOver = false;
		isPaused = false;
		isBossKeyHidden = false;
		dropCounter = 0;
		dropInterval = 1000;
		nextPiece = null;
		updateScoreUI();
		spawnPiece();
		hideOverlay();
		lastTime = performance.now();
		runGame();
	};

	const spawnPiece = () => {
		const pieces = ["I", "J", "L", "O", "S", "T", "Z"];

		if (!nextPiece) {
			const type = pieces[Math.floor(Math.random() * pieces.length)];
			const matrix = TETROMINOES[type];
			nextPiece = {
				matrix,
				color: type,
			};
		}

		// Active piece becomes the next piece
		const type = nextPiece.color;
		const matrix = nextPiece.matrix;
		activePiece = {
			matrix,
			pos: {
				x: Math.floor((COLS - matrix[0].length) / 2),
				y: 0,
			},
			color: type,
		};

		// Generate new next piece
		const nextType = pieces[Math.floor(Math.random() * pieces.length)];
		const nextMatrix = TETROMINOES[nextType];
		nextPiece = {
			matrix: nextMatrix,
			color: nextType,
		};

		// Draw next piece
		drawNextPiece();

		if (
			checkCollision(activePiece.pos.x, activePiece.pos.y, activePiece.matrix)
		) {
			isGameOver = true;
			saveHighScore();
			const gameOverButtons = [{ text: "Restart", action: resetGame }];
			if (window.isSecretGame) {
				gameOverButtons.push({
					text: "Quit",
					action: exitSecretGameUI,
				});
			}
			showOverlay("Game Over", gameOverButtons);
		}
	};

	const drawNextPiece = () => {
		if (!nextCtx || !nextPiece) return;

		nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);

		const matrix = nextPiece.matrix;
		const blockSize = 10;
		const matrixSize = matrix.length;

		// Calculate start X and Y to center it
		const startX = (nextCanvas.width - matrixSize * blockSize) / 2;
		const startY = (nextCanvas.height - matrixSize * blockSize) / 2;

		for (let y = 0; y < matrixSize; y += 1) {
			for (let x = 0; x < matrix[y].length; x += 1) {
				const val = matrix[y][x];
				if (val !== 0) {
					nextCtx.fillStyle = COLORS[val];
					nextCtx.fillRect(
						startX + x * blockSize,
						startY + y * blockSize,
						blockSize,
						blockSize,
					);

					nextCtx.strokeStyle = "rgba(0,0,0,0.3)";
					nextCtx.lineWidth = 1;
					nextCtx.strokeRect(
						startX + x * blockSize,
						startY + y * blockSize,
						blockSize,
						blockSize,
					);
				}
			}
		}
	};

	const checkCollision = (ax, ay, matrix) => {
		for (let y = 0; y < matrix.length; y += 1) {
			for (let x = 0; x < matrix[y].length; x += 1) {
				if (matrix[y][x] !== 0) {
					const nextX = ax + x;
					const nextY = ay + y;
					if (
						nextX < 0 ||
						nextX >= COLS ||
						nextY >= ROWS ||
						(nextY >= 0 && board[nextY][nextX] !== 0)
					) {
						return true;
					}
				}
			}
		}
		return false;
	};

	const mergePiece = () => {
		const matrix = activePiece.matrix;
		const pos = activePiece.pos;
		for (let y = 0; y < matrix.length; y += 1) {
			for (let x = 0; x < matrix[y].length; x += 1) {
				if (matrix[y][x] !== 0) {
					const boardY = pos.y + y;
					if (boardY >= 0) {
						board[boardY][pos.x + x] = matrix[y][x];
					}
				}
			}
		}
	};

	const rotatePiece = () => {
		const matrix = activePiece.matrix;
		const n = matrix.length;
		const rotated = Array.from({ length: n }, () => Array(n).fill(0));
		for (let y = 0; y < n; y += 1) {
			for (let x = 0; x < n; x += 1) {
				rotated[x][n - 1 - y] = matrix[y][x];
			}
		}

		const originalX = activePiece.pos.x;
		let offset = 1;
		activePiece.matrix = rotated;

		while (
			checkCollision(activePiece.pos.x, activePiece.pos.y, activePiece.matrix)
		) {
			activePiece.pos.x += offset;
			offset = -(offset + (offset > 0 ? 1 : -1));
			if (Math.abs(offset) > matrix[0].length) {
				// Undo rotation if collision cannot be resolved
				activePiece.pos.x = originalX;
				activePiece.matrix = matrix;
				return;
			}
		}
	};

	const clearLines = () => {
		let linesCleared = 0;
		for (let y = ROWS - 1; y >= 0; y -= 1) {
			// Un-clearable garbage lines are filled with '8'
			const isGarbage = board[y].includes(8);
			const isFull = board[y].every((cell) => cell !== 0) && !isGarbage;

			if (isFull) {
				board.splice(y, 1);
				board.unshift(Array(COLS).fill(0));
				linesCleared += 1;
				y += 1; // Check same row index again
			}
		}

		if (linesCleared > 0) {
			const scores = [0, 100, 300, 500, 800];
			score += scores[Math.min(linesCleared, 4)];
			updateScoreUI();
		}
	};

	const updateScoreUI = () => {
		const scoreVal = document.getElementById("tetrisScore");
		if (scoreVal) scoreVal.textContent = padScore(score);
	};

	const handleInput = (e) => {
		if (isGameOver || isPaused || isBossKeyHidden || isProcessingComplete)
			return;

		if (
			["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " "].includes(e.key)
		) {
			e.preventDefault();
			e.stopPropagation();
		}

		switch (e.key) {
			case "ArrowLeft":
				if (
					!checkCollision(
						activePiece.pos.x - 1,
						activePiece.pos.y,
						activePiece.matrix,
					)
				) {
					activePiece.pos.x -= 1;
				}
				break;
			case "ArrowRight":
				if (
					!checkCollision(
						activePiece.pos.x + 1,
						activePiece.pos.y,
						activePiece.matrix,
					)
				) {
					activePiece.pos.x += 1;
				}
				break;
			case "ArrowDown":
				moveDown();
				break;
			case "ArrowUp":
				rotatePiece();
				break;
			case " ": // Hard drop
				while (
					!checkCollision(
						activePiece.pos.x,
						activePiece.pos.y + 1,
						activePiece.matrix,
					)
				) {
					activePiece.pos.y += 1;
				}
				moveDown();
				break;
		}
	};

	const moveDown = () => {
		if (
			checkCollision(
				activePiece.pos.x,
				activePiece.pos.y + 1,
				activePiece.matrix,
			)
		) {
			mergePiece();
			clearLines();
			spawnPiece();
		} else {
			activePiece.pos.y += 1;
		}
		dropCounter = 0;
	};

	const draw = () => {
		ctx.fillStyle = "#09090b";
		ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

		// Draw board grid
		for (let y = 0; y < ROWS; y += 1) {
			for (let x = 0; x < COLS; x += 1) {
				const val = board[y][x];
				if (val !== 0) {
					drawBlock(x, y, val);
				}
			}
		}

		// Draw active piece
		if (activePiece) {
			const matrix = activePiece.matrix;
			const pos = activePiece.pos;
			for (let y = 0; y < matrix.length; y += 1) {
				for (let x = 0; x < matrix[y].length; x += 1) {
					if (matrix[y][x] !== 0) {
						drawBlock(pos.x + x, pos.y + y, matrix[y][x]);
					}
				}
			}
		}
	};

	const drawBlock = (x, y, type) => {
		ctx.fillStyle = COLORS[type];
		ctx.fillRect(x * BLOCK_SIZE, y * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);

		// Subtle inner border styling for premium look
		ctx.strokeStyle = "rgba(0,0,0,0.3)";
		ctx.lineWidth = 1;
		ctx.strokeRect(x * BLOCK_SIZE, y * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
	};

	const runGame = (time = 0) => {
		if (isGameOver || isPaused || isBossKeyHidden) return;

		const deltaTime = time - lastTime;
		lastTime = time;
		dropCounter += deltaTime;

		if (dropCounter >= dropInterval) {
			moveDown();
		}

		draw();
		animationFrameId = requestAnimationFrame(runGame);
	};

	// Dynamic Difficulty: "Rising Tide"
	const pushGarbageLine = () => {
		if (isGameOver || isBossKeyHidden || isProcessingComplete) return;

		// Shift all board cells up one row
		board.shift();
		// Add solid gray, un-clearable block line at the bottom
		board.push(Array(COLS).fill(8));

		// Shift active piece up if it collides with the rising grid
		if (
			activePiece &&
			checkCollision(activePiece.pos.x, activePiece.pos.y, activePiece.matrix)
		) {
			activePiece.pos.y -= 1;
			if (
				checkCollision(activePiece.pos.x, activePiece.pos.y, activePiece.matrix)
			) {
				isGameOver = true;
				saveHighScore();
				const gameOverButtons = [{ text: "Restart", action: resetGame }];
				if (window.isSecretGame) {
					gameOverButtons.push({
						text: "Quit",
						action: exitSecretGameUI,
					});
				}
				showOverlay("Game Over", gameOverButtons);
			}
		}

		draw();
	};

	// Boss Key logic
	const toggleBossKey = () => {
		if (isProcessingComplete) return;

		if (window.isSecretGame) {
			exitSecretGameUI();
			return;
		}

		isBossKeyHidden = !isBossKeyHidden;
		if (isBossKeyHidden) {
			// Pause loop
			cancelAnimationFrame(animationFrameId);
			isPaused = true;

			// Hide game, reveal standard processing interface
			document.getElementById("tetrisContainer").style.display = "none";
			document.getElementById("trimNormalContent").classList.remove("hidden");
			document.getElementById("trimNormalFooter").classList.remove("hidden");
		} else {
			// Hide standard interface, reveal game
			document.getElementById("trimNormalContent").classList.add("hidden");
			document.getElementById("trimNormalFooter").classList.add("hidden");
			const container = document.getElementById("tetrisContainer");
			container.classList.remove("hidden");
			container.style.display = "flex";

			// Resume loop
			isPaused = false;
			lastTime = performance.now();
			runGame();
		}
	};

	// Expose function to show normal progress screen (e.g. when clicking X button during Tetris)
	window.showNormalProgressScreen = () => {
		if (isProcessingComplete) return;

		isBossKeyHidden = true;
		cancelAnimationFrame(animationFrameId);
		isPaused = true;

		document.getElementById("tetrisContainer").style.display = "none";
		document.getElementById("trimNormalContent").classList.remove("hidden");
		document.getElementById("trimNormalFooter").classList.remove("hidden");
	};

	// Overlay management
	const showOverlay = (title, buttons) => {
		const titleEl = document.getElementById("tetrisOverlayTitle");
		const container = document.getElementById("tetrisOverlayButtons");
		if (titleEl) titleEl.textContent = title;
		if (container) {
			container.innerHTML = buttons
				.map(
					(btn, idx) =>
						`<button type="button" class="btn btn-primary text-xs w-full py-1.5 cursor-pointer uppercase font-bold tracking-wide" id="tetrisOverlayBtn-${idx}">${btn.text}</button>`,
				)
				.join("");

			buttons.forEach((btn, idx) => {
				const el = document.getElementById(`tetrisOverlayBtn-${idx}`);
				if (el) {
					el.addEventListener("click", () => {
						btn.action();
					});
				}
			});
		}
		document.getElementById("tetrisOverlay").classList.remove("hidden");
	};

	const hideOverlay = () => {
		document.getElementById("tetrisOverlay").classList.add("hidden");
	};

	// External hook: update state from app.js
	window.updateTetrisProgress = (pct) => {
		const milestone = Math.floor(pct / 10) * 10;
		if (
			milestone > 0 &&
			milestone < 100 &&
			!triggeredMilestones.has(milestone)
		) {
			triggeredMilestones.add(milestone);
			pushGarbageLine();
		}
	};

	// External hook: processing complete
	window.onVideoProcessingFinished = () => {
		isProcessingComplete = true;
		saveHighScore();

		// Stop game loop
		cancelAnimationFrame(animationFrameId);

		// Show completion overlay options
		showOverlay("Processing Complete!", [
			{
				text: "Continue Game",
				action: () => {
					hideOverlay();
					// Resume game at max drop speed
					isPaused = false;
					isGameOver = false;
					dropInterval = 50;
					lastTime = performance.now();
					runGame();
				},
			},
			{
				text: "Quit to LS.Video",
				action: () => {
					saveHighScore();
					// Clean up keyboard events
					window.removeEventListener("keydown", handleInput);
					exitSecretGameUI();
					// Restore normal dialog contents for future runs
					document.getElementById("tetrisContainer").style.display = "none";
					document.getElementById("tetrisContainer").classList.add("hidden");
					document
						.getElementById("trimNormalContent")
						.classList.remove("hidden");
					document
						.getElementById("trimNormalFooter")
						.classList.remove("hidden");

					// Reset spinner & progress elements
					const spinner = document.getElementById("trimProgressSpinner");
					if (spinner) spinner.classList.add("hidden");
					const progressBar = document.getElementById("trimProgressBar");
					const progressText = document.getElementById("trimProgressText");
					if (progressBar) progressBar.style.width = "0%";
					if (progressText) progressText.textContent = "0%";
				},
			},
		]);
	};
	window.cleanupTetris = () => {
		cancelAnimationFrame(animationFrameId);
		window.removeEventListener("keydown", handleInput);
		isPaused = true;
		isGameOver = false;
	};
})();
