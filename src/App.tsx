import { useEffect, useMemo, useRef, useState } from "react";

type HistoryItem = {
  id: string;
  text: string;
  createdAt: string;
};

const HISTORY_KEY = "speech-recognition-history";
const MAX_RECORDING_SECONDS = 30;
const FRIENDLY_PERMISSION_MESSAGE = "需要麦克风权限才能录音，请在浏览器设置中允许访问麦克风";
const BLOCKED_PERMISSION_MESSAGE =
  "当前浏览器已阻止麦克风访问，无法再次弹出授权窗口。请点击地址栏旁的站点权限图标，将麦克风改为“允许”，然后刷新页面。";

type MicPermissionState = "unknown" | "granted" | "denied" | "prompt" | "unsupported";
type UploadAudio = {
  blob: Blob;
  filename: string;
  mimeType: string;
};

function formatDate(isoTime: string): string {
  return new Date(isoTime).toLocaleString("zh-CN", { hour12: false });
}

function formatTimeOnly(date: Date): string {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function sanitizeRecognitionText(text: string): string {
  let cleaned = text.trim();
  const prefixPatterns = [
    /^好的[，,]?\s*/i,
    /^音频转写内容如下[:：]?\s*/i,
    /^这段音频转写为中文文本是[:：]?\s*/i,
    /^以下是(?:该|这段)?音频(?:的)?(?:转写|识别)结果[:：]?\s*/i,
    /^转写结果[:：]?\s*/i,
    /^识别结果[:：]?\s*/i,
    /^当然可以[，,]?\s*/i
  ];

  // 持续剥离前置客套语，兼容多行前缀。
  let changed = true;
  while (changed) {
    changed = false;
    cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    for (const pattern of prefixPatterns) {
      const next = cleaned.replace(pattern, "").trim();
      if (next !== cleaned) {
        cleaned = next;
        changed = true;
      }
    }
    cleaned = cleaned.replace(/^\s*\n+/, "").trim();
  }

  return cleaned;
}

function isRefusalStyleReply(text: string): boolean {
  const normalized = text.toLowerCase();
  const patterns = [
    "无法处理音频转写任务",
    "我目前无法处理音频转写任务",
    "不过，如果你有文本内容需要帮助",
    "我无法直接处理音频",
    "cannot process audio transcription",
    "i can't process audio"
  ];
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = `语音识别失败（HTTP ${response.status}），请检查 API Key、模型配置和网络后重试。`;
  const responseClone = response.clone();
  try {
    const payload = await response.json();
    const messageCandidates = [
      payload?.error?.message,
      payload?.error?.msg,
      payload?.message,
      payload?.msg,
      payload?.detail,
      payload?.error_description
    ];
    const pickedMessage = messageCandidates.find((item) => typeof item === "string" && item.trim().length > 0);
    if (pickedMessage) {
      return pickedMessage;
    }
    return `语音识别失败（HTTP ${response.status}）：${JSON.stringify(payload).slice(0, 240)}`;
  } catch {
    try {
      const text = (await responseClone.text()).trim();
      if (text) {
        return `语音识别失败（HTTP ${response.status}）：${text.slice(0, 180)}`;
      }
    } catch {
      // no-op: keep fallback
    }
    return fallback;
  }
}

function isUnsupportedFormatMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("不支持当前文件格式") ||
    normalized.includes("文件格式不支持") ||
    normalized.includes("unsupported") ||
    normalized.includes("format")
  );
}

function isModelNotFoundMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("模型不存在") ||
    normalized.includes("model not found") ||
    normalized.includes("invalid model") ||
    normalized.includes("model does not exist")
  );
}

function isWrongEndpointMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("message should not be empty") || normalized.includes("messages");
}

function pickRecorderMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function getFileExtension(mimeType: string): string {
  if (mimeType.includes("wav")) {
    return "wav";
  }
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("mp4")) {
    return "m4a";
  }
  return "webm";
}

async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const channelCount = Math.min(audioBuffer.numberOfChannels, 2);
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = channelCount * bytesPerSample;
    const wavBuffer = new ArrayBuffer(44 + samples * blockAlign);
    const view = new DataView(wavBuffer);

    const writeString = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples * blockAlign, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples * blockAlign, true);

    const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));
    let offset = 44;
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const sample = Math.max(-1, Math.min(1, channels[channelIndex][sampleIndex]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, intSample, true);
        offset += bytesPerSample;
      }
    }

    return new Blob([wavBuffer], { type: "audio/wav" });
  } finally {
    await audioContext.close();
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const base64 = value.includes(",") ? value.split(",")[1] : "";
      if (!base64) {
        reject(new Error("音频编码失败，请重试录音。"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => {
      reject(new Error("音频编码失败，请重试录音。"));
    };
    reader.readAsDataURL(blob);
  });
}

function extractChatRecognitionText(payload: any): string {
  const messageContent = payload?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent.trim();
  }
  if (Array.isArray(messageContent)) {
    const textParts = messageContent
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (typeof item?.text === "string") {
          return item.text;
        }
        if (typeof item?.content === "string") {
          return item.content;
        }
        return "";
      })
      .filter(Boolean);
    return textParts.join("\n").trim();
  }
  if (typeof payload?.text === "string") {
    return payload.text.trim();
  }
  return "";
}

function detectAudioFormatForVoiceModel(mimeType: string): "wav" | "mp3" {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) {
    return "wav";
  }
  if (normalized.includes("mp3") || normalized.includes("mpeg")) {
    return "mp3";
  }
  return "wav";
}

function pcmChunksToWavBlob(chunks: Float32Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm16 = new Int16Array(totalSamples);
  let writeOffset = 0;

  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      pcm16[writeOffset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      writeOffset += 1;
    }
  }

  const bytesPerSample = 2;
  const dataByteLength = pcm16.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataByteLength, true);

  let byteOffset = 44;
  for (let i = 0; i < pcm16.length; i += 1) {
    view.setInt16(byteOffset, pcm16[i], true);
    byteOffset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [resultText, setResultText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => crypto.randomUUID());
  const [micPermission, setMicPermission] = useState<MicPermissionState>("unknown");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioMimeType, setAudioMimeType] = useState("audio/wav");
  const [isFinalizingRecording, setIsFinalizingRecording] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const capturedSamplesRef = useRef(0);
  const sampleRateRef = useRef(16000);
  const isRecordingRef = useRef(false);
  const recordingStartRef = useRef<number | null>(null);
  const recordingTickRef = useRef<number | null>(null);
  const autoStopTimerRef = useRef<number | null>(null);
  const resultTextRef = useRef("");

  const selectedHistory = useMemo(
    () => history.find((item) => item.id === selectedHistoryId) ?? null,
    [history, selectedHistoryId]
  );

  useEffect(() => {
    const rawHistory = localStorage.getItem(HISTORY_KEY);
    if (!rawHistory) {
      return;
    }

    try {
      const parsed = JSON.parse(rawHistory) as HistoryItem[];
      if (Array.isArray(parsed)) {
        setHistory(parsed);
      }
    } catch {
      localStorage.removeItem(HISTORY_KEY);
    }
  }, []);

  useEffect(() => {
    resultTextRef.current = resultText;
  }, [resultText]);

  useEffect(() => {
    if (!navigator.permissions?.query) {
      setMicPermission("unknown");
      return;
    }

    let isMounted = true;
    let permissionStatus: PermissionStatus | null = null;

    const syncPermission = async () => {
      try {
        permissionStatus = await navigator.permissions.query({
          name: "microphone" as PermissionName
        });
        if (!isMounted) {
          return;
        }
        setMicPermission(permissionStatus.state as MicPermissionState);
        permissionStatus.onchange = () => {
          setMicPermission(permissionStatus?.state as MicPermissionState);
        };
      } catch {
        if (isMounted) {
          setMicPermission("unsupported");
        }
      }
    };

    void syncPermission();

    return () => {
      isMounted = false;
      if (permissionStatus) {
        permissionStatus.onchange = null;
      }
    };
  }, []);

  useEffect(
    () => () => {
      if (recordingTickRef.current !== null) {
        window.clearInterval(recordingTickRef.current);
      }
      if (autoStopTimerRef.current !== null) {
        window.clearTimeout(autoStopTimerRef.current);
      }
      if (audioPreviewUrl) {
        URL.revokeObjectURL(audioPreviewUrl);
      }
      stopTracks();
    },
    [audioPreviewUrl]
  );

  const saveHistory = (nextHistory: HistoryItem[]) => {
    setHistory(nextHistory);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const cleanupAudioNodes = async () => {
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    monitorGainRef.current?.disconnect();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    monitorGainRef.current = null;
    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const stopRecordingTimers = () => {
    if (recordingTickRef.current !== null) {
      window.clearInterval(recordingTickRef.current);
      recordingTickRef.current = null;
    }
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    recordingStartRef.current = null;
  };

  const clearLastRecordingState = async (clearError = true) => {
    isRecordingRef.current = false;
    stopRecordingTimers();
    pcmChunksRef.current = [];
    capturedSamplesRef.current = 0;
    setIsRecording(false);
    setIsFinalizingRecording(false);
    setRecordingSeconds(0);
    setAudioBlob(null);
    setAudioMimeType("audio/wav");
    setAudioPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return "";
    });
    if (clearError) {
      setErrorText("");
    }
    await cleanupAudioNodes();
    stopTracks();
  };

  const requestMicrophonePermission = async (): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPermission("unsupported");
      setErrorText("当前浏览器不支持录音功能，请更换浏览器后重试。");
      return false;
    }

    try {
      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName
        });
        setMicPermission(status.state as MicPermissionState);
        if (status.state === "denied") {
          setErrorText(BLOCKED_PERMISSION_MESSAGE);
          return false;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicPermission("granted");
      setErrorText("");
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setMicPermission("denied");
        setErrorText(BLOCKED_PERMISSION_MESSAGE);
        return false;
      }
      setMicPermission("denied");
      setErrorText(FRIENDLY_PERMISSION_MESSAGE);
      return false;
    }
  };

  const startRecording = async () => {
    if (isFinalizingRecording) {
      setErrorText("上一段录音正在处理中，请稍候再开始。");
      return;
    }
    if (isRecognizing) {
      setErrorText("上一段录音正在识别中，请稍候再开始新录音。");
      return;
    }
    await clearLastRecordingState(true);
    const granted = await requestMicrophonePermission();
    if (!granted) {
      return;
    }

    try {
      await cleanupAudioNodes();
      stopTracks();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioContext = new AudioContext();
      await audioContext.resume();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const monitorGain = audioContext.createGain();
      monitorGain.gain.value = 0;

      sourceNode.connect(processorNode);
      processorNode.connect(monitorGain);
      monitorGain.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      sourceNodeRef.current = sourceNode;
      processorNodeRef.current = processorNode;
      monitorGainRef.current = monitorGain;
      sampleRateRef.current = audioContext.sampleRate;
      pcmChunksRef.current = [];
      capturedSamplesRef.current = 0;
      isRecordingRef.current = true;
      setAudioMimeType("audio/wav");

      processorNode.onaudioprocess = (event) => {
        if (!isRecordingRef.current) {
          return;
        }
        const channelData = event.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(channelData));
        capturedSamplesRef.current += channelData.length;
        const elapsedBySamples = Math.floor(capturedSamplesRef.current / sampleRateRef.current);
        setRecordingSeconds(Math.min(elapsedBySamples, MAX_RECORDING_SECONDS));
      };
      recordingStartRef.current = Date.now();
      setRecordingSeconds(0);
      recordingTickRef.current = window.setInterval(() => {
        if (!recordingStartRef.current) {
          return;
        }
        const elapsedByTime = Math.floor((Date.now() - recordingStartRef.current) / 1000);
        const elapsedBySamples = Math.floor(capturedSamplesRef.current / sampleRateRef.current);
        const elapsed = Math.max(elapsedByTime, elapsedBySamples);
        setRecordingSeconds(Math.min(elapsed, MAX_RECORDING_SECONDS));
      }, 250);
      autoStopTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, MAX_RECORDING_SECONDS * 1000);
      setIsRecording(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setMicPermission("denied");
        setErrorText(FRIENDLY_PERMISSION_MESSAGE);
      } else {
        setErrorText("录音启动失败，请重试。");
      }
      stopRecordingTimers();
      stopTracks();
    }
  };

  const stopRecording = () => {
    if (!isRecordingRef.current) {
      return;
    }
    isRecordingRef.current = false;
    setIsFinalizingRecording(true);
    stopRecordingTimers();
    setIsRecording(false);
    void (async () => {
      try {
        const totalSamples = pcmChunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalSamples < 1600) {
          setErrorText("没有检测到有效录音，请确认麦克风输入后重试。");
          return;
        }

        const blob = pcmChunksToWavBlob(pcmChunksRef.current, sampleRateRef.current);
        setAudioBlob(blob);
        setAudioMimeType("audio/wav");
        setAudioPreviewUrl((previousUrl) => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
          return URL.createObjectURL(blob);
        });
        void runRecognition(blob, true);
      } catch {
        setErrorText("录音处理失败，请重试。");
      } finally {
        pcmChunksRef.current = [];
        capturedSamplesRef.current = 0;
        await cleanupAudioNodes();
        stopTracks();
        setIsFinalizingRecording(false);
      }
    })();
  };

  const handleRecordToggle = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    void startRecording();
  };

  const runRecognition = async (targetAudioBlob?: Blob, append = false) => {
    const blobForRecognition = targetAudioBlob ?? audioBlob;
    if (!blobForRecognition) {
      setErrorText("请先录制音频，再开始识别。");
      return;
    }

    const apiKey = import.meta.env.VITE_ZHIPU_API_KEY;
    const configuredModel = import.meta.env.VITE_ZHIPU_STT_MODEL ?? "glm-asr-2512";
    const endpoint =
      import.meta.env.VITE_ZHIPU_STT_URL ?? "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";

    if (!apiKey) {
      setErrorText("缺少 API Key。请在 .env 文件中设置 VITE_ZHIPU_API_KEY。");
      return;
    }

    setIsRecognizing(true);
    setErrorText("");

    try {
      const wavBlob = blobForRecognition.type.includes("wav") ? blobForRecognition : await blobToWav(blobForRecognition);
      const formData = new FormData();
      formData.append("model", configuredModel);
      formData.append("language", "zh");
      formData.append("file", wavBlob, "recording.wav");

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: formData
      });

      if (!response.ok) {
        const errorMessage = await parseErrorMessage(response);
        if (isModelNotFoundMessage(errorMessage)) {
          throw new Error("模型不存在或无权限。请确认 .env 中 VITE_ZHIPU_STT_MODEL=glm-asr-2512 且账号已开通该模型。");
        }
        throw new Error(errorMessage);
      }

      const result = (await response.json()) as { text?: string };
      const text = sanitizeRecognitionText(result.text ?? "");
      if (!text) {
        setErrorText("识别完成，但没有检测到清晰语音内容。");
        return;
      }

      const stampedText = `[${formatTimeOnly(new Date())}] ${text}`;
      const baseText = append ? resultTextRef.current.trim() : "";
      const nextText = baseText ? `${baseText}\n${stampedText}` : stampedText;
      setResultText(nextText);

      const existingIndex = history.findIndex((item) => item.id === currentSessionId);
      const nowIso = new Date().toISOString();
      let nextHistory: HistoryItem[];
      if (existingIndex >= 0) {
        nextHistory = history.map((item, index) =>
          index === existingIndex
            ? {
                ...item,
                text: nextText
              }
            : item
        );
      } else {
        const historyItem: HistoryItem = {
          id: currentSessionId,
          text: nextText,
          createdAt: nowIso
        };
        nextHistory = [historyItem, ...history];
      }
      saveHistory(nextHistory);
      setSelectedHistoryId(currentSessionId);
    } catch (error) {
      let message = error instanceof Error ? error.message : "语音识别失败，请稍后重试。";
      if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
        message = "请求识别服务失败，请检查网络连接，以及浏览器是否拦截了跨域请求。";
      }
      setErrorText(message);
    } finally {
      setIsRecognizing(false);
    }
  };

  const handleCopyResult = async () => {
    if (!resultText.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(resultText);
    } catch {
      setErrorText("复制失败，请手动复制识别结果。");
    }
  };

  const deleteHistory = (id: string) => {
    const nextHistory = history.filter((item) => item.id !== id);
    saveHistory(nextHistory);

    if (selectedHistoryId === id) {
      setSelectedHistoryId(nextHistory[0]?.id ?? null);
    }
    if (currentSessionId === id) {
      setCurrentSessionId(crypto.randomUUID());
      setResultText("");
    }
  };

  const openHistoryDetail = (item: HistoryItem) => {
    void clearLastRecordingState(true);
    setSelectedHistoryId(item.id);
    setCurrentSessionId(item.id);
    setResultText(item.text);
  };

  const startNewSession = () => {
    void clearLastRecordingState(true);
    const nextSessionId = crypto.randomUUID();
    setCurrentSessionId(nextSessionId);
    setSelectedHistoryId(null);
    setResultText("");
  };

  const remainingSeconds = Math.max(0, MAX_RECORDING_SECONDS - recordingSeconds);
  const showPermissionCard = micPermission === "denied" && !isRecording;
  const showInlineError = Boolean(errorText) && !showPermissionCard;

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-3 py-6 text-slate-900 sm:px-4 sm:py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Snow的语音笔记</h1>
        <p className="mt-2 text-sm text-slate-600">录音、自动识别、会话沉淀，一页完成</p>
      </div>
      <div className="grid w-full gap-4 sm:gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="panel min-w-0 rounded-3xl p-4 sm:p-6">
          <button
            type="button"
            onClick={startNewSession}
            className="mb-4 w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            开始新会话
          </button>
          <h2 className="text-base font-semibold text-slate-800">历史会话</h2>
          {history.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">暂无历史记录，识别成功后会自动保存。</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {history.map((item) => (
                <li key={item.id} className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openHistoryDetail(item)}
                    className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left text-sm transition-all ${
                      selectedHistoryId === item.id
                        ? "border-sky-400 bg-gradient-to-br from-sky-50 to-cyan-50 text-sky-900 shadow-sm"
                        : "soft-divider bg-white/80 hover:bg-slate-50"
                    }`}
                  >
                    <p className="font-semibold text-slate-700">{formatDate(item.createdAt)}</p>
                    <p className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-slate-500">{item.text}</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteHistory(item.id)}
                    aria-label="删除会话"
                    title="删除会话"
                    className="rounded-lg p-2 text-red-500 transition hover:bg-red-50"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="panel min-w-0 rounded-3xl p-4 sm:p-8">
          <header className="text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">当前会话</h2>
            <p className="mt-2 text-sm text-slate-600">单次会话支持多段录音，停止后自动识别并追加结果</p>
          </header>

          <section className="mt-8">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-700">识别结果（可编辑）</h2>
              {selectedHistory && <p className="text-xs text-slate-500">查看中：{formatDate(selectedHistory.createdAt)}</p>}
            </div>
            <div className="relative pb-12">
              <textarea
                value={resultText}
                onChange={(event) => setResultText(event.target.value)}
                placeholder="每次停止录音后会自动识别并追加到这里..."
                className="h-80 w-full resize-y rounded-2xl border border-slate-200 bg-white/90 p-4 text-sm leading-6 text-slate-700 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
              <button
                type="button"
                disabled={!resultText.trim()}
                onClick={() => void handleCopyResult()}
                className="absolute -bottom-1 right-0 z-10 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                复制
              </button>
            </div>
          </section>

          <div className="mt-8 flex flex-col items-center gap-4 sm:gap-6">
            <button
              type="button"
              onClick={handleRecordToggle}
              disabled={isFinalizingRecording}
              className={`relative flex h-[104px] w-[104px] items-center justify-center rounded-full text-base font-semibold text-white shadow-lg transition duration-300 sm:h-[120px] sm:w-[120px] sm:text-lg ${
                isRecording
                  ? "recording-pulse bg-red-500 hover:bg-red-600"
                  : isFinalizingRecording
                    ? "cursor-not-allowed bg-slate-400"
                    : "bg-gradient-to-br from-sky-500 to-cyan-500 hover:from-sky-600 hover:to-cyan-600"
              }`}
            >
              <span className="relative z-10">{isRecording ? "停止" : isFinalizingRecording ? "处理中" : "录音"}</span>
            </button>

            {showPermissionCard && (
              <div className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p>{errorText || FRIENDLY_PERMISSION_MESSAGE}</p>
                <button
                  type="button"
                  onClick={() => void requestMicrophonePermission()}
                  className="mt-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700"
                >
                  重新请求权限
                </button>
              </div>
            )}

            {isRecording && (
              <div className="w-full rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-sm font-medium text-red-600">
                已录制 {recordingSeconds}s / 剩余 {remainingSeconds}s（最长 {MAX_RECORDING_SECONDS}s，到时自动停止）
              </div>
            )}

            {isRecognizing && (
              <div className="flex w-full items-center gap-3 rounded-xl border border-sky-100 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                正在识别刚录制的语音片段，请稍候...
              </div>
            )}

            {showInlineError && <p className="w-full text-sm text-red-500">{errorText}</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
