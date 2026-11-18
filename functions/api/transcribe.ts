const apiUrl = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";

const DEFAULT_MODEL = "glm-asr-2512";

interface Env {
  ZHIPU_API_KEY?: string;
  ZHIPU_STT_MODEL?: string;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

export function onRequestOptions(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  try {
    const apiKey = env.ZHIPU_API_KEY;
    if (!apiKey) {
      return json({ error: { message: "服务端未配置 ZHIPU_API_KEY。" } }, 500);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ error: { message: "请求体不是有效的表单数据。" } }, 400);
    }

    const file = form.get("file");
    if (!file || typeof file === "string") {
      return json({ error: { message: "请求缺少音频文件。" } }, 400);
    }

    form.set("model", env.ZHIPU_STT_MODEL || DEFAULT_MODEL);
    if (!form.get("language")) {
      form.set("language", "zh");
    }

    const upstream = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const data = (await upstream.json().catch(() => null)) as {
      text?: string;
      error?: { message?: string };
    } | null;

    if (!upstream.ok) {
      return json(
        {
          error: {
            message:
              data?.error?.message ||
              `智谱接口请求失败（HTTP ${upstream.status}）。`,
          },
        },
        upstream.status,
      );
    }

    return json({ text: data?.text ?? "" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务异常";
    return json({ error: { message } }, 500);
  }
}
