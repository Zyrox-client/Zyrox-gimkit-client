// ==UserScript==
// @name         Zyrox packet sniffer
// @namespace    https://github.com/zyrox
// @version      0.1.0
// @description  Logs every websocket packet (incoming + outgoing) to the browser console.
// @author       Zyrox
// @match        https://www.gimkit.com/join*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const PREFIX = "[PacketSniffer]";
  const ENGINE_PACKET_TYPES = {
    "0": "OPEN",
    "1": "CLOSE",
    "2": "PING",
    "3": "PONG",
    "4": "MESSAGE",
    "5": "UPGRADE",
    "6": "NOOP",
  };
  const SOCKET_PACKET_TYPES = {
    "0": "CONNECT",
    "1": "DISCONNECT",
    "2": "EVENT",
    "3": "ACK",
    "4": "ERROR",
    "5": "BINARY_EVENT",
    "6": "BINARY_ACK",
  };

  function tryJson(input) {
    if (typeof input !== "string") return null;
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }

  function parseTextPacket(text) {
    if (!text || typeof text !== "string") return { raw: text };

    const engineType = text[0];
    const engineName = ENGINE_PACKET_TYPES[engineType] || "UNKNOWN";
    const payload = text.slice(1);

    if (engineType !== "4") {
      return { engineType, engineName, payload, raw: text };
    }

    const socketType = payload[0];
    const socketName = SOCKET_PACKET_TYPES[socketType] || "UNKNOWN";
    const body = payload.slice(1);

    return {
      engineType,
      engineName,
      socketType,
      socketName,
      body,
      json: tryJson(body),
      raw: text,
    };
  }

  function parseBinaryPacket(value) {
    if (value instanceof Blob) {
      return { kind: "Blob", size: value.size, type: value.type || "(none)" };
    }
    if (value instanceof ArrayBuffer) {
      return { kind: "ArrayBuffer", bytes: value.byteLength };
    }
    if (ArrayBuffer.isView(value)) {
      return { kind: value.constructor?.name || "TypedArray", bytes: value.byteLength };
    }
    return { kind: typeof value };
  }

  function logPacket(direction, socket, payload) {
    const parsed = typeof payload === "string" ? parseTextPacket(payload) : parseBinaryPacket(payload);
    console.log(PREFIX, direction, {
      url: socket.url,
      readyState: socket.readyState,
      parsed,
      raw: payload,
      timestamp: new Date().toISOString(),
    });
  }

  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function patchedSend(data) {
    try {
      logPacket("OUT", this, data);
    } catch (err) {
      console.warn(PREFIX, "failed to log outgoing packet", err);
    }
    return originalSend.call(this, data);
  };

  const originalAddEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (type !== "message" || typeof listener !== "function") {
      return originalAddEventListener.call(this, type, listener, options);
    }

    const wrapped = function wrappedMessageListener(event) {
      try {
        logPacket("IN", this, event.data);
      } catch (err) {
        console.warn(PREFIX, "failed to log incoming packet", err);
      }
      return listener.call(this, event);
    };

    return originalAddEventListener.call(this, type, wrapped, options);
  };

  const onMessageDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  if (onMessageDescriptor?.set && onMessageDescriptor?.get) {
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true,
      enumerable: onMessageDescriptor.enumerable,
      get: onMessageDescriptor.get,
      set(handler) {
        if (typeof handler !== "function") {
          return onMessageDescriptor.set.call(this, handler);
        }

        const wrapped = (event) => {
          try {
            logPacket("IN", this, event.data);
          } catch (err) {
            console.warn(PREFIX, "failed to log incoming packet", err);
          }
          return handler.call(this, event);
        };

        return onMessageDescriptor.set.call(this, wrapped);
      },
    });
  }

  console.log(PREFIX, "installed");
})();
