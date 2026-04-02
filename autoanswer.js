// ==UserScript==
// @name         Gimkit Auto Answer (from example.js)
// @namespace    https://github.com/TheLazySquid/GimkitCheat
// @version      1.0.0
// @description  Automatically answers Gimkit questions using the same core logic from example.js, with debug logging.
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[AutoAnswer]";
  const TICK_MS = 1000;

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

  function findSocketManager() {
    if (state.socketManager) return state.socketManager;

    const direct = globalThis.socketManager;
    if (
      direct &&
      typeof direct.sendMessage === "function" &&
      typeof direct.addEventListener === "function"
    ) {
      state.socketManager = direct;
      debug("Found socketManager on window.socketManager");
      return state.socketManager;
    }

    for (const value of Object.values(globalThis)) {
      if (!value || typeof value !== "object") continue;
      if (
        typeof value.sendMessage === "function" &&
        typeof value.addEventListener === "function" &&
        ("transportType" in value || "socket" in value)
      ) {
        state.socketManager = value;
        debug("Found socketManager candidate via global scan");
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

  function attachListeners() {
    if (state.listenersAttached) return true;

    const socketManager = findSocketManager();
    if (!socketManager) return false;

    socketManager.addEventListener("deviceChanges", (event) => {
      for (const { id, data } of event.detail || []) {
        for (const key in data || {}) {
          if (key == "GLOBAL_questions") {
            try {
              state.questions = JSON.parse(data[key]);
              state.answerDeviceId = id;
              debug("Got questions (colyseus)", state.questions.length);
            } catch (error) {
              warn("Failed to parse GLOBAL_questions", error);
            }
          }

          if (state.playerId && key == `PLAYER_${state.playerId}_currentQuestionId`) {
            state.currentQuestionId = data[key];
          }
        }
      }
    });

    socketManager.addEventListener("colyseusMessage", (event) => {
      if (event.detail?.type === "AUTH_ID") {
        state.playerId = event.detail?.message ?? null;
        debug("Captured playerId", state.playerId);
      }
    });

    socketManager.addEventListener("blueboatMessage", (event) => {
      if (event.detail?.key != "STATE_UPDATE") return;

      switch (event.detail.data.type) {
        case "GAME_QUESTIONS":
          state.questions = event.detail.data.value;
          debug("Got questions (blueboat)", state.questions.length);
          break;
        case "PLAYER_QUESTION_LIST":
          state.questionIdList = event.detail.data.value.questionList;
          state.currentQuestionIndex = event.detail.data.value.questionIndex;
          break;
        case "PLAYER_QUESTION_LIST_INDEX":
          state.currentQuestionIndex = event.detail.data.value;
          break;
      }
    });

    state.listenersAttached = true;
    debug("Auto-answer listeners attached");
    return true;
  }

  function startAutoAnswer() {
    if (state.answerInterval) clearInterval(state.answerInterval);
    state.answerInterval = setInterval(answerQuestion, TICK_MS);
    debug("Auto-answer enabled");
  }

  function bootstrap() {
    if (!attachListeners()) {
      setTimeout(bootstrap, 500);
      return;
    }
    startAutoAnswer();
  }

  // Debug hotkey: Alt + A toggles auto-answer on/off.
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.key.toLowerCase() !== "a") return;

    state.autoAnswerEnabled = !state.autoAnswerEnabled;
    debug(`Toggled auto-answer: ${state.autoAnswerEnabled ? "ON" : "OFF"}`);
  });

  bootstrap();
})();
