// ==UserScript==
// @name         Gimkit Auto Answer (No UI)
// @description  Auto answer only (no menu/modules UI). Core answering logic copied from example.js.
// @namespace    https://www.github.com/TheLazySquid/GimkitCheat/
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @version      1.1.0
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[AutoAnswer]";
  const ANSWER_INTERVAL_MS = 1000; // example.js behavior
  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  const state = {
    socketManager: null,
    questions: [],
    answerDeviceId: null,
    currentQuestionId: null,
    questionIdList: [],
    currentQuestionIndex: -1,
    playerId: null,
    enabled: true,
    intervalId: null,
    listenersAttached: false,
    discoveryAttempts: 0,
  };

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  function captureCurrentQuestionKey(key, value) {
    const match = /^PLAYER_(.+?)_currentQuestionId$/.exec(String(key));
    if (!match) return false;
    if (!state.playerId) {
      state.playerId = match[1];
      log("Inferred player id from deviceChanges key:", state.playerId);
    }
    state.currentQuestionId = value;
    return true;
  }

  function isSocketManagerLike(obj) {
    return (
      !!obj &&
      typeof obj === "object" &&
      typeof obj.sendMessage === "function" &&
      typeof obj.addEventListener === "function"
    );
  }

  function attachListeners() {
    if (state.listenersAttached || !state.socketManager) return;

    log("Attaching listeners to socket manager", {
      transportType: state.socketManager.transportType,
      hasSocket: !!state.socketManager.socket,
    });

    state.socketManager.addEventListener("deviceChanges", (event) => {
      log("deviceChanges event received", event.detail?.length ?? 0);
      for (const { id, data } of event.detail || []) {
        for (const key in data || {}) {
          if (key === "GLOBAL_questions") {
            try {
              state.questions = JSON.parse(data[key]);
              state.answerDeviceId = id;
              log("Got questions (colyseus)", state.questions.length);
            } catch (error) {
              warn("Failed to parse GLOBAL_questions", error);
            }
          }

          if (captureCurrentQuestionKey(key, data[key])) {
            log("Updated currentQuestionId", state.currentQuestionId);
          }
        }
      }
    });

    state.socketManager.addEventListener("colyseusMessage", (event) => {
      if (event.detail?.type === "AUTH_ID") {
        state.playerId = event.detail?.message ?? state.playerId;
        log("Got player id:", state.playerId);
      }
    });

    state.socketManager.addEventListener("blueboatMessage", (event) => {
      if (event.detail?.key !== "STATE_UPDATE") return;

      switch (event.detail.data.type) {
        case "GAME_QUESTIONS":
          state.questions = event.detail.data.value;
          log("Got questions (blueboat)", state.questions.length);
          break;
        case "PLAYER_QUESTION_LIST":
          state.questionIdList = event.detail.data.value.questionList;
          state.currentQuestionIndex = event.detail.data.value.questionIndex;
          log("Got PLAYER_QUESTION_LIST", {
            count: state.questionIdList.length,
            index: state.currentQuestionIndex,
          });
          break;
        case "PLAYER_QUESTION_LIST_INDEX":
          state.currentQuestionIndex = event.detail.data.value;
          log("Got PLAYER_QUESTION_LIST_INDEX", state.currentQuestionIndex);
          break;
      }
    });

    state.listenersAttached = true;
    log("Listeners attached");
  }

  function findSocketManager() {
    if (state.socketManager) return state.socketManager;

    state.discoveryAttempts += 1;

    const direct = pageWindow.socketManager;
    if (isSocketManagerLike(direct)) {
      state.socketManager = direct;
      log("Found socketManager on pageWindow.socketManager");
      attachListeners();
      return state.socketManager;
    }

    // Fallback scan for objects that look like socket managers.
    for (const candidate of Object.values(pageWindow)) {
      if (!isSocketManagerLike(candidate)) continue;
      state.socketManager = candidate;
      log("Found socket manager via pageWindow global scan", {
        transportType: candidate.transportType,
      });
      attachListeners();
      return state.socketManager;
    }

    if (state.discoveryAttempts % 20 === 0) {
      warn("Still waiting for socketManager...", {
        attempts: state.discoveryAttempts,
        hasPageSocketManager: !!pageWindow.socketManager,
      });
    }

    return null;
  }

  // Kept in original example.js style.
  function answerQuestion() {
    if (!state.enabled) return;

    const socketManager = findSocketManager();
    if (!socketManager) return;

    if (socketManager.transportType === "colyseus") {
      if (state.currentQuestionId == null) return;

      // find the correct question
      const question = state.questions.find((q) => q._id == state.currentQuestionId);
      if (!question) return;

      const packet = {
        key: "answered",
        deviceId: state.answerDeviceId,
        data: {},
      };

      // create a packet to send to the server
      if (question.type == "text") {
        packet.data.answer = question.answers[0].text;
      } else {
        const correctAnswerId = question.answers.find((a) => a.correct)._id;
        packet.data.answer = correctAnswerId;
      }

      socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
      log("Answered colyseus", {
        questionId: state.currentQuestionId,
        answer: packet.data.answer,
      });
    } else {
      const questionId = state.questionIdList[state.currentQuestionIndex];
      const question = state.questions.find((q) => q._id == questionId);
      if (!question) return;

      let answer;
      if (question.type == "mc") {
        answer = question.answers.find((a) => a.correct)._id;
      } else {
        answer = question.answers[0].text;
      }

      socketManager.sendMessage("QUESTION_ANSWERED", { answer, questionId });
      log("Answered blueboat", { questionId, answer });
    }
  }

  function installSocketManagerSetterTrap() {
    const existing = pageWindow.socketManager;
    if (isSocketManagerLike(existing)) {
      state.socketManager = existing;
      log("socketManager existed at start");
      attachListeners();
    }

    let tracked = existing;

    try {
      Object.defineProperty(pageWindow, "socketManager", {
        configurable: true,
        enumerable: true,
        get() {
          return tracked;
        },
        set(value) {
          tracked = value;
          if (!isSocketManagerLike(value)) return;
          state.socketManager = value;
          log("socketManager assigned via setter trap");
          attachListeners();
        },
      });
      log("Installed socketManager setter trap on pageWindow");
    } catch (error) {
      warn("Could not install socketManager trap", error);
    }
  }

  function start() {
    log("Booting auto-answer script...");
    installSocketManagerSetterTrap();
    findSocketManager();

    if (state.intervalId) clearInterval(state.intervalId);
    state.intervalId = setInterval(answerQuestion, ANSWER_INTERVAL_MS);
    log(`Auto-answer interval started (${ANSWER_INTERVAL_MS}ms)`);
  }

  // Optional debug toggle.
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.key.toLowerCase() !== "a") return;
    state.enabled = !state.enabled;
    log(`Auto-answer ${state.enabled ? "enabled" : "disabled"}`);
  });

  start();
})();
