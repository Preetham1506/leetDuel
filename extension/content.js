/**
 * LeetRace Chrome Extension - Content Script (Manifest V3)
 * Runs on: leetcode.com/problems/*
 */

(async () => {
  console.log("LeetRace Helper active on LeetCode page.");

  // Fetch cached match information
  const { activeMatch } = await chrome.storage.local.get("activeMatch");
  if (!activeMatch) {
    console.log("No active LeetRace match found in extension storage.");
    return;
  }

  // Parse slugs to verify if the player is on the correct LeetCode problem
  const getSlug = (url) => {
    if (!url) return null;
    const match = url.match(/\/problems\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
  };

  const currentSlug = getSlug(window.location.href);
  const targetSlug = getSlug(activeMatch.questionUrl);

  if (!currentSlug || !targetSlug) {
    return;
  }

  if (currentSlug !== targetSlug) {
    injectWrongProblemOverlay(activeMatch.questionUrl, activeMatch.questionTitle || "Target Problem");
    return;
  }

  // If on the correct problem, initialize the race client
  initializeRaceClient(activeMatch);
})();

/**
 * Injects a full-screen warning if the player is on the wrong LeetCode page.
 */
function injectWrongProblemOverlay(targetUrl, problemTitle) {
  const overlay = document.createElement("div");
  overlay.id = "leetrace-wrong-problem-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    backgroundColor: "rgba(15, 23, 42, 0.95)",
    color: "#ffffff",
    zIndex: "999999",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    fontFamily: "'Outfit', 'Inter', sans-serif",
    textAlign: "center"
  });

  overlay.innerHTML = `
    <h1 style="font-size: 32px; color: #ef4444; margin-bottom: 20px; font-weight: 700;">WRONG PROBLEM PAGE!</h1>
    <p style="font-size: 18px; margin-bottom: 30px; color: #cbd5e1;">You are supposed to be solving:</p>
    <a href="${targetUrl}" style="padding: 12px 28px; background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4);">
      Go to: ${problemTitle}
    </a>
  `;
  document.body.appendChild(overlay);
}

/**
 * Initializes the LeetRace WebSocket client and builds the HUD overlay.
 */
function initializeRaceClient(match) {
  const apiHost = match.apiHost || "localhost:8000";
  const isSecure = !apiHost.startsWith("localhost") && !apiHost.startsWith("127.0.0.1") && !apiHost.startsWith("192.168.");
  const wsProtocol = isSecure ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${apiHost}/ws/match/${match.matchId}?user_id=${match.userId}&token=${match.token}`;
  let ws = new WebSocket(wsUrl);
  let timerInterval = null;
  let typingTimeout = null;
  let isSabotageUsed = false;

  // Create UI overlay container
  const hud = createHUDElement(match);
  document.body.appendChild(hud);

  // --- Draggable HUD Logic ---
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  hud.style.cursor = "grab";

  hud.addEventListener("mousedown", (e) => {
    if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input")) return;
    
    isDragging = true;
    hud.style.cursor = "grabbing";
    
    const rect = hud.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    
    hud.style.bottom = "auto";
    hud.style.right = "auto";
    hud.style.left = `${startLeft + deltaX}px`;
    hud.style.top = `${startTop + deltaY}px`;
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      hud.style.cursor = "grab";
    }
  });

  // Setup WebSocket Handlers
  ws.onopen = () => {
    console.log("Connected to LeetRace WebSocket Server.");
    // Report initial focus state
    ws.send(JSON.stringify({ type: "PLAYER_BLUR", is_blurred: !document.hasFocus() }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerMessage(data);
  };

  ws.onclose = () => {
    console.log("LeetRace WebSocket connection closed.");
  };

  ws.onerror = (error) => {
    console.error("LeetRace WebSocket error:", error);
  };

  // --- Anti-Cheat Tab Focus Tracking ---
  window.onblur = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "PLAYER_BLUR", is_blurred: true }));
    }
  };

  window.onfocus = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "PLAYER_BLUR", is_blurred: false }));
    }
    // Remove blur warning message if active
    const warning = document.getElementById("leetrace-blur-warning");
    if (warning) warning.remove();
  };

  // --- Typing Indicator ---
  // Listen for key presses in LeetCode's editor area
  document.addEventListener("keydown", (e) => {
    const editor = document.querySelector(".monaco-editor");
    if (editor && editor.contains(e.target)) {
      triggerTyping();
    }
  });

  function triggerTyping() {
    if (ws.readyState !== WebSocket.OPEN) return;
    
    if (!typingTimeout) {
      ws.send(JSON.stringify({ type: "TYPING_STATUS", is_coding: true }));
    }
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "TYPING_STATUS", is_coding: false }));
      }
      typingTimeout = null;
    }, 2500);
  }

  // --- Background Script Communication ---
  // Listen for submission completions forwarded by background.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "LEETCODE_SUBMISSION_RESULT") {
      console.log("Submission intercept forwarded result:", message);
      if (message.isAccepted && ws.readyState === WebSocket.OPEN) {
        // Send victory claim to the backend
        ws.send(JSON.stringify({ type: "SUBMIT_SUCCESS" }));
      } else {
        showToast(`Submission evaluated: ${message.statusMsg}`, "#ef4444");
      }
    }
  });

  // --- Server Message Router ---
  function handleServerMessage(data) {
    switch (data.type) {
      case "SYNC_STATE":
        updateTimerUI(data.seconds_left);
        break;

      case "TIMER_TICK":
        updateTimerUI(data.seconds_left);
        break;

      case "OPPONENT_BLUR":
        updateOpponentBlurUI(data.is_blurred);
        break;

      case "OPPONENT_TYPING":
        updateOpponentTypingUI(data.is_coding);
        break;

      case "sabotage_triggered":
        applySabotageEffect(data.sabotage_type);
        break;

      case "player_submitted_correctly":
        {
          const isWinner = data.winner_id === match.userId;
          showGameEndOverlay(isWinner, data);
          ws.close();
        }
        break;

      case "MATCH_OVER":
        if (data.reason === "forfeit") {
          // If we are not the winner, we forfeitted
          const isWinner = data.winner_id === match.userId;
          showGameEndOverlay(isWinner, data, isWinner ? "Opponent Forfeited (Anti-Cheat)" : "You Forfeited (Left page too long)");
        } else if (data.reason === "timeout") {
          showGameEndOverlay(false, data, "Time is Up! Match ended in a draw.");
        } else {
          const isWinner = data.winner_id === match.userId;
          showGameEndOverlay(isWinner, data);
        }
        ws.close();
        break;

      default:
        break;
    }
  }

  // --- UI Modification Functions ---

  function createHUDElement(matchInfo) {
    const hudCard = document.createElement("div");
    hudCard.id = "leetrace-hud-card";
    
    // Inject a modern Google Font
    const fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap";
    document.head.appendChild(fontLink);

    Object.assign(hudCard.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "9999",
      width: "480px",
      padding: "12px 20px",
      background: "rgba(15, 23, 42, 0.75)",
      backdropFilter: "blur(12px)",
      webkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255, 255, 255, 0.1)",
      borderRadius: "14px",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.4)",
      fontFamily: "'Outfit', 'Inter', sans-serif",
      color: "#ffffff",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      transition: "all 0.3s ease"
    });

    hudCard.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px;">
        <span style="font-weight: 700; background: linear-gradient(90deg, #60a5fa, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 16px;">LEETRACE COMPETITIVE</span>
        <div id="leetrace-timer" style="font-size: 20px; font-weight: 700; color: #f59e0b; font-variant-numeric: tabular-nums; letter-spacing: 0.5px;">15:00</div>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">Opponent</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div id="leetrace-status-dot" style="width: 8px; height: 8px; border-radius: 50%; background-color: #10b981; transition: background 0.3s;"></div>
            <span id="leetrace-opponent-name" style="font-size: 14px; font-weight: 600; color: #f8fafc;">Connecting...</span>
          </div>
          <span id="leetrace-opponent-status-text" style="font-size: 12px; color: #cbd5e1; font-style: italic;">Active</span>
        </div>
        <button id="leetrace-sabotage-btn" style="padding: 8px 16px; background: linear-gradient(135deg, #ec4899, #d946ef); border: none; border-radius: 8px; color: white; font-weight: 600; font-size: 13px; cursor: pointer; box-shadow: 0 4px 10px rgba(236, 72, 153, 0.3); transition: transform 0.2s, opacity 0.2s;">
          🚀 Flashbang
        </button>
      </div>
    `;

    // Sabotage click listener
    setTimeout(() => {
      const btn = hudCard.querySelector("#leetrace-sabotage-btn");
      btn.addEventListener("click", () => {
        if (isSabotageUsed || ws.readyState !== WebSocket.OPEN) return;
        
        ws.send(JSON.stringify({ type: "TRIGGER_SABOTAGE", sabotage_type: "flashbang" }));
        isSabotageUsed = true;
        btn.disabled = true;
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
        btn.innerText = "Used";
        showToast("Flashbang sabotage deployed!", "#d946ef");
      });
    }, 100);

    return hudCard;
  }

  function updateTimerUI(seconds) {
    const timerElem = document.getElementById("leetrace-timer");
    if (!timerElem) return;
    
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerElem.innerText = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    
    if (seconds <= 60) {
      timerElem.style.color = "#ef4444";
      timerElem.style.animation = "pulse 1s infinite alternate";
    }
  }

  function updateOpponentBlurUI(isBlurred) {
    const dot = document.getElementById("leetrace-status-dot");
    const label = document.getElementById("leetrace-opponent-status-text");
    
    if (!dot || !label) return;

    if (isBlurred) {
      dot.style.backgroundColor = "#ef4444";
      label.innerText = "Out of Focus! (15s Forfeit Warning)";
      label.style.color = "#f87171";
      showWarningNotification(true);
    } else {
      dot.style.backgroundColor = "#10b981";
      label.innerText = "Active";
      label.style.color = "#cbd5e1";
      showWarningNotification(false);
    }
  }

  function updateOpponentTypingUI(isCoding) {
    const label = document.getElementById("leetrace-opponent-status-text");
    const dot = document.getElementById("leetrace-status-dot");
    
    if (!label || !dot || dot.style.backgroundColor === "rgb(239, 68, 68)") return; // Don't override blur warning

    if (isCoding) {
      label.innerText = "Writing code...";
      label.style.color = "#60a5fa";
    } else {
      label.innerText = "Active";
      label.style.color = "#cbd5e1";
    }
  }

  function showWarningNotification(show) {
    let warning = document.getElementById("leetrace-blur-warning");
    if (show) {
      if (warning) return;
      warning = document.createElement("div");
      warning.id = "leetrace-blur-warning";
      Object.assign(warning.style, {
        position: "fixed",
        top: "100px",
        left: "50%",
        transform: "translateX(50%)",
        zIndex: "10000",
        padding: "10px 20px",
        backgroundColor: "#ef4444",
        color: "white",
        borderRadius: "8px",
        fontFamily: "sans-serif",
        fontWeight: "bold",
        fontSize: "14px",
        boxShadow: "0 4px 15px rgba(239, 68, 68, 0.4)"
      });
      warning.innerText = "⚠️ OPPONENT IS OUT OF FOCUS! FORFEIT INITIATED.";
      document.body.appendChild(warning);
    } else {
      if (warning) warning.remove();
    }
  }

  // --- Sabotage Execution (Flashbang Effect) ---
  function applySabotageEffect(type) {
    if (type === "flashbang") {
      // 1. Create flashing mask
      const flash = document.createElement("div");
      Object.assign(flash.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        backgroundColor: "#ffffff",
        zIndex: "100000",
        transition: "opacity 4.5s ease-out",
        opacity: "0.95",
        pointerEvents: "none"
      });
      document.body.appendChild(flash);

      // 2. Blur main code editor and page content
      const oldFilter = document.body.style.filter;
      document.body.style.filter = "blur(12px)";

      // Trigger fade out on next frame
      requestAnimationFrame(() => {
        flash.style.opacity = "0";
      });

      // 3. Clear effects after 5 seconds
      setTimeout(() => {
        flash.remove();
        document.body.style.filter = oldFilter;
      }, 5000);

      showToast("💥 You got FLASHBANGED! Screen blurred for 5s.", "#ec4899");
    }
  }

  // --- Game End Screen Overlay ---
  function showGameEndOverlay(isWinner, data, customReason = null) {
    const endOverlay = document.createElement("div");
    Object.assign(endOverlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      backgroundColor: "rgba(15, 23, 42, 0.95)",
      zIndex: "999999",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      color: "white",
      fontFamily: "'Outfit', sans-serif"
    });

    const titleColor = isWinner ? "#10b981" : "#ef4444";
    const titleText = isWinner ? "🏆 VICTORY!" : "💀 DEFEAT";
    
    let eloInfo = "";
    if (data.elo_updates) {
      const playerElo = data.elo_updates[match.userId];
      if (playerElo) {
        const changeSign = playerElo.change >= 0 ? "+" : "";
        eloInfo = `
          <div style="font-size: 20px; color: #cbd5e1; margin-top: 15px;">
            ELO: ${playerElo.before} ➔ <strong style="color: #60a5fa">${playerElo.after}</strong> 
            (<span style="color: ${playerElo.change >= 0 ? '#10b981' : '#f87171'}">${changeSign}${playerElo.change}</span>)
          </div>
        `;
      }
    }

    const durationText = data.duration_seconds 
      ? `Time Elapsed: ${Math.floor(data.duration_seconds / 60)}m ${data.duration_seconds % 60}s` 
      : "";

    endOverlay.innerHTML = `
      <h1 style="font-size: 64px; font-weight: 700; color: ${titleColor}; margin-bottom: 10px; letter-spacing: 1px;">${titleText}</h1>
      <p style="font-size: 22px; color: #94a3b8; margin-bottom: 20px;">
        ${customReason || (isWinner ? "You solved the problem first!" : `Winner: ${data.winner_username}`)}
      </p>
      <div style="background: rgba(30, 41, 59, 0.5); padding: 20px 40px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); text-align: center;">
        <span style="font-size: 16px; color: #cbd5e1;">${durationText}</span>
        ${eloInfo}
      </div>
      <button id="leetrace-exit-btn" style="margin-top: 40px; padding: 12px 32px; background: #3b82f6; border: none; border-radius: 8px; color: white; font-weight: 600; font-size: 16px; cursor: pointer; transition: background 0.2s;">
        Back to LeetRace Lobby
      </button>
    `;

    document.body.appendChild(endOverlay);

    setTimeout(() => {
      document.getElementById("leetrace-exit-btn").addEventListener("click", () => {
        // Clear cached match from storage
        chrome.storage.local.remove("activeMatch", () => {
          // Redirect back to our platform lobby
          const frontendHost = match.frontendHost || "localhost:3000";
          window.location.href = `http://${frontendHost}/lobby`;
        });
      });
    }, 100);
  }

  // --- Helper Toast/Alert ---
  function showToast(message, bgColor) {
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "100000",
      padding: "12px 24px",
      backgroundColor: bgColor || "#1e293b",
      color: "white",
      borderRadius: "8px",
      fontFamily: "sans-serif",
      fontWeight: "600",
      fontSize: "13px",
      boxShadow: "0 4px 15px rgba(0,0,0,0.3)",
      opacity: "0",
      transform: "translateY(20px)",
      transition: "all 0.3s ease"
    });
    toast.innerText = message;
    document.body.appendChild(toast);

    // Fade in
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    // Fade out and remove
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(20px)";
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
}
