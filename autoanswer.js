// ==UserScript==
// @name         Gimkit Auto Answer (No UI)
// @description  Auto answer only. Runs in page context so socketManager/events are visible.
// @namespace    https://www.github.com/TheLazySquid/GimkitCheat/
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @version      1.2.0
// @grant        none
// ==/UserScript==

(function injectIntoPageContext() {
  "use strict";

  function pageMain() {
    const LOG_PREFIX = "[AutoAnswer][page]";
    const ANSWER_INTERVAL_MS = 1000; // example.js behavior

    const state = {
      socketManager: null,
      questions: [],
      answerDeviceId: null,
      currentQuestionId: null,
      questionIdList: [],
      currentQuestionIndex: -1,
      playerId: null,
      listenersAttached: false,
      answerInterval: null,
    };

    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);

    function onSocketManagerAvailable(socketManager) {
      if (!socketManager || state.listenersAttached) return;
      state.socketManager = socketManager;

      socketManager.addEventListener("deviceChanges", (event) => {
        for (const { id, data } of event.detail || []) {
          for (const key in data || {}) {
            if (key == "GLOBAL_questions") {
              try {
                state.questions = JSON.parse(data[key]);
                state.answerDeviceId = id;
                log("Got questions (colyseus)", state.questions.length);
              } catch (error) {
                warn("Failed to parse GLOBAL_questions", error);
              }
            }

            if (key == `PLAYER_${state.playerId}_currentQuestionId`) {
              state.currentQuestionId = data[key];
              log("Updated currentQuestionId", state.currentQuestionId);
            }

            const match = /^PLAYER_(.+?)_currentQuestionId$/.exec(key);
            if (match && !state.playerId) {
              state.playerId = match[1];
              state.currentQuestionId = data[key];
              log("Derived playerId/currentQuestionId from key", state.playerId, state.currentQuestionId);
            }
          }
        }
      });

      socketManager.addEventListener("colyseusMessage", (event) => {
        if (event.detail?.type === "AUTH_ID") {
          state.playerId = event.detail?.message ?? state.playerId;
          log("Got player id", state.playerId);
        }
      });

      socketManager.addEventListener("blueboatMessage", (event) => {
        if (event.detail?.key != "STATE_UPDATE") return;

        switch (event.detail.data.type) {
          case "GAME_QUESTIONS":
            state.questions = event.detail.data.value;
            log("Got questions (blueboat)", state.questions.length);
            break;
          case "PLAYER_QUESTION_LIST":
            state.questionIdList = event.detail.data.value.questionList;
            state.currentQuestionIndex = event.detail.data.value.questionIndex;
            log("Updated PLAYER_QUESTION_LIST", {
              count: state.questionIdList.length,
              index: state.currentQuestionIndex,
            });
            break;
          case "PLAYER_QUESTION_LIST_INDEX":
            state.currentQuestionIndex = event.detail.data.value;
            log("Updated PLAYER_QUESTION_LIST_INDEX", state.currentQuestionIndex);
            break;
        }
      });

      state.listenersAttached = true;
      log("Auto-answer listeners attached");
    }

    function answerQuestion() {
      if (!state.socketManager) return;

      const transportType = state.socketManager.transportType;

      // same answer flow as example.js
      if (transportType === "colyseus") {
        if (state.currentQuestionId == null) return;

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
          const correctAnswerId = question.answers.find((a) => a.correct)?._id;
          if (!correctAnswerId) return;
          packet.data.answer = correctAnswerId;
        }

        state.socketManager.sendMessage("MESSAGE_FOR_DEVICE", packet);
        log("Sent MESSAGE_FOR_DEVICE", { questionId: state.currentQuestionId, answer: packet.data.answer });
      } else {
        const questionId = state.questionIdList[state.currentQuestionIndex];
        const question = state.questions.find((q) => q._id == questionId);
        if (!question) return;

        let answer;
        if (question.type == "mc") {
          answer = question.answers.find((a) => a.correct)?._id;
        } else {
          answer = question.answers[0]?.text;
        }

        if (!answer) return;
        state.socketManager.sendMessage("QUESTION_ANSWERED", { answer, questionId });
        log("Sent QUESTION_ANSWERED", { questionId, answer });
      }
    }

    function installSocketManagerTrap() {
      const existing = window.socketManager;
      if (existing) onSocketManagerAvailable(existing);

      let tracked = existing;
      try {
        Object.defineProperty(window, "socketManager", {
          configurable: true,
          enumerable: true,
          get() {
            return tracked;
          },
          set(value) {
            tracked = value;
            log("socketManager assigned");
            onSocketManagerAvailable(value);
          },
        });
        log("Installed socketManager setter trap");
      } catch (error) {
        warn("Could not install socketManager setter trap", error);
      }
    }

    function start() {
      log("Booting auto-answer script...");
      installSocketManagerTrap();

      state.answerInterval = setInterval(answerQuestion, ANSWER_INTERVAL_MS);
      log(`Auto-answer interval started (${ANSWER_INTERVAL_MS}ms)`);

      let attempts = 0;
      const wait = setInterval(() => {
        attempts += 1;
        if (!state.socketManager && window.socketManager) {
          onSocketManagerAvailable(window.socketManager);
        }
        if (!state.socketManager && attempts % 20 === 0) {
          warn("Still waiting for socketManager...", {
            attempts,
            hasPageSocketManager: Boolean(window.socketManager),
          });
        }
        if (state.socketManager && state.listenersAttached) {
          clearInterval(wait);
          log("Bootstrap complete");
        }
      }, 100);
    }

    start();
  }

  const script = document.createElement("script");
  script.textContent = `;(${pageMain.toString()})();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
})();
