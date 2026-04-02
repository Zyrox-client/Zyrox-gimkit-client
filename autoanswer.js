// ==UserScript==
// @name         Gimkit Auto Answer (No UI)
// @description  Auto answer only (no menu/modules UI). Core answering logic copied from example.js.
// @namespace    https://www.github.com/TheLazySquid/GimkitCheat/
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @version      1.0.0
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[AutoAnswer]";
  const ANSWER_INTERVAL_MS = 150;

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
  };

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  function captureCurrentQuestionKey(key, value) {
    const match = /^PLAYER_(.+?)_currentQuestionId$/.exec(String(key));
    if (!match) return false;
    if (!state.playerId) state.playerId = match[1];
    state.currentQuestionId = value;
    return true;
  }

  function getSocketManager() {
    if (state.socketManager) return state.socketManager;

    const direct = globalThis.socketManager;
    if (
      direct &&
      typeof direct.sendMessage === "function" &&
      typeof direct.addEventListener === "function"
    ) {
      state.socketManager = direct;
      attachListeners();
      return state.socketManager;
    }

    for (const candidate of Object.values(globalThis)) {
      if (!candidate || typeof candidate !== "object") continue;
      if (
        typeof candidate.sendMessage === "function" &&
        typeof candidate.addEventListener === "function" &&
        ("transportType" in candidate || "socket" in candidate)
      ) {
        state.socketManager = candidate;
        log("Found socket manager via global scan");
        attachListeners();
        return state.socketManager;
      }
    }

    return null;
  }

  function attachListeners() {
    if (state.listenersAttached || !state.socketManager) return;

    state.socketManager.addEventListener("deviceChanges", (event) => {
      for (const { id, data } of event.detail || []) {
        for (const key in data || {}) {
          if (key === "GLOBAL_questions") {
            try {
              state.questions = JSON.parse(data[key]);
              state.answerDeviceId = id;
              log("Got questions", state.questions.length);
              answerQuestion();
            } catch (error) {
              warn("Failed to parse GLOBAL_questions", error);
            }
          }

          if (captureCurrentQuestionKey(key, data[key])) {
            answerQuestion();
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
          log("Got questions", state.questions.length);
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
    log("Listeners attached");
  }

  // 1:1 answering behavior from example.js (colyseus + blueboat branches)
  function answerQuestion() {
    if (!state.enabled) return;

    const socketManager = getSocketManager();
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
      log("Answered colyseus", state.currentQuestionId);
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
      log("Answered blueboat", questionId);
    }
  }

  function installSocketManagerSetterTrap() {
    const existing = globalThis.socketManager;
    if (existing) {
      state.socketManager = existing;
      attachListeners();
    }

    let tracked = existing;

    try {
      Object.defineProperty(globalThis, "socketManager", {
        configurable: true,
        enumerable: true,
        get() {
          return tracked;
        },
        set(value) {
          tracked = value;
          state.socketManager = value;
          log("socketManager assigned");
          attachListeners();
        },
      });
    } catch (error) {
      warn("Could not install socketManager trap", error);
    }
  }

  function start() {
    installSocketManagerSetterTrap();
    getSocketManager();

    if (state.intervalId) clearInterval(state.intervalId);
    state.intervalId = setInterval(answerQuestion, ANSWER_INTERVAL_MS);
    log("Auto-answer started");
  }

  // Alt + A toggle (debug convenience)
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.key.toLowerCase() !== "a") return;
    state.enabled = !state.enabled;
    log(`Auto-answer ${state.enabled ? "enabled" : "disabled"}`);
  });

  start();
})();
