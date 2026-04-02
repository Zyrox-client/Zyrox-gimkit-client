// ==UserScript==
// @name         Gimkit Auto Answer (from example.js)
// @namespace    https://github.com/TheLazySquid/GimkitCheat
// @version      1.1.0
// @description  Automatically answers Gimkit questions using the same core logic from example.js, with debug logging.
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[AutoAnswer]";
  const TICK_MS = 250;

  const state = {
    socketManager: null,
    questions: [],
    answerDeviceId: null,
    currentQuestionId: null,
    questionIdList: [],
    currentQuestionIndex: -1,
    playerId: null,
    autoAnswerEnabled: true,
    answerInterval: null,
    listenersAttached: false,
  };

  const debug = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  function capturePlayerQuestionKey(key, value) {
    const match = /^PLAYER_(.+?)_currentQuestionId$/.exec(String(key));
    if (!match) return false;

    state.playerId = state.playerId || match[1];
    state.currentQuestionId = value;
    return true;
  }

  function attachListenersTo(manager) {
    if (!manager || state.listenersAttached) return false;

    state.socketManager = manager;

    manager.addEventListener("deviceChanges", (event) => {
      for (const { id, data } of event.detail || []) {
        for (const key in data || {}) {
          if (key == "GLOBAL_questions") {
            try {
              state.questions = JSON.parse(data[key]);
              state.answerDeviceId = id;
              debug("Got questions (colyseus)", state.questions.length);
              answerQuestion();
            } catch (error) {
              warn("Failed to parse GLOBAL_questions", error);
            }
          }

          if (capturePlayerQuestionKey(key, data[key])) {
            debug("Captured currentQuestionId", state.currentQuestionId);
            answerQuestion();
          }
        }
      }
    });

    manager.addEventListener("colyseusMessage", (event) => {
      if (event.detail?.type === "AUTH_ID") {
        state.playerId = event.detail?.message ?? state.playerId;
        debug("Captured playerId", state.playerId);
      }
    });

    manager.addEventListener("blueboatMessage", (event) => {
      if (event.detail?.key != "STATE_UPDATE") return;

      switch (event.detail.data.type) {
        case "GAME_QUESTIONS":
          state.questions = event.detail.data.value;
          debug("Got questions (blueboat)", state.questions.length);
          answerQuestion();
          break;
        case "PLAYER_QUESTION_LIST":
          state.questionIdList = event.detail.data.value.questionList;
          state.currentQuestionIndex = event.detail.data.value.questionIndex;
          answerQuestion();
          break;
        case "PLAYER_QUESTION_LIST_INDEX":
          state.currentQuestionIndex = event.detail.data.value;
          answerQuestion();
          break;
      }
    });

    state.listenersAttached = true;
    debug("Auto-answer listeners attached immediately");
    return true;
  }

  function installSocketManagerTrap() {
    const existing = globalThis.socketManager;
    if (existing && typeof existing.sendMessage === "function" && typeof existing.addEventListener === "function") {
      attachListenersTo(existing);
    }

    let captured = existing;

    try {
      Object.defineProperty(globalThis, "socketManager", {
        configurable: true,
        enumerable: true,
        get() {
          return captured;
        },
        set(value) {
          captured = value;
          debug("socketManager assigned");
          if (
            value &&
            typeof value.sendMessage === "function" &&
            typeof value.addEventListener === "function"
          ) {
            attachListenersTo(value);
          }
        },
      });
      debug("Installed socketManager setter trap");
    } catch (error) {
      warn("Could not install socketManager trap", error);
    }
  }

  function findSocketManager() {
    if (state.socketManager) return state.socketManager;

    const direct = globalThis.socketManager;
    if (direct && typeof direct.sendMessage === "function" && typeof direct.addEventListener === "function") {
      attachListenersTo(direct);
      return state.socketManager;
    }

    for (const value of Object.values(globalThis)) {
      if (!value || typeof value !== "object") continue;
      if (
        typeof value.sendMessage === "function" &&
        typeof value.addEventListener === "function" &&
        ("transportType" in value || "socket" in value)
      ) {
        debug("Found socketManager candidate via global scan");
        attachListenersTo(value);
        return state.socketManager;
      }
    }

    return null;
  }

  function answerQuestion() {
    if (!state.autoAnswerEnabled) return;

    const socketManager = findSocketManager();
    if (!socketManager) return;

    const transportType = socketManager.transportType;

    // Same logic as example.js.
    if (transportType === "colyseus") {
      if (state.currentQuestionId == null || state.answerDeviceId == null) return;

      const question = state.questions.find((q) => q._id == state.currentQuestionId);
      if (!question) return;

      const packet = {
        key: "answered",
        deviceId: state.answerDeviceId,
        data: {},
      };

      if (question.type == "text") {
        packet.data.answer = question.answers[0].text;
      } else {
        const correctAnswerId = question.answers.find((a) => a.correct)._id;
        packet.data.answer = correctAnswerId;
      }

      socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
      debug("Answered colyseus question", {
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
      debug("Answered blueboat question", { questionId, answer });
    }
  }

  function startAutoAnswer() {
    if (state.answerInterval) clearInterval(state.answerInterval);
    state.answerInterval = setInterval(answerQuestion, TICK_MS);
    debug(`Auto-answer enabled (tick ${TICK_MS}ms)`);
  }

  function bootstrap() {
    installSocketManagerTrap();
    startAutoAnswer();

    const warmup = setInterval(() => {
      if (findSocketManager()) {
        clearInterval(warmup);
        debug("Socket manager ready");
      }
    }, 100);
  }

  // Debug hotkey: Alt + A toggles auto-answer on/off.
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.key.toLowerCase() !== "a") return;

    state.autoAnswerEnabled = !state.autoAnswerEnabled;
    debug(`Toggled auto-answer: ${state.autoAnswerEnabled ? "ON" : "OFF"}`);
  });

  bootstrap();
})();
