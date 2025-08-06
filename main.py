import asyncio
import websockets
import base64
import requests
import openai
import os
import json
import uuid
from dotenv import load_dotenv

load_dotenv()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
openai.api_key = OPENAI_API_KEY

conversation_history = []

async def handle_audio(websocket, path):
    print("📞 Call connected.")

    # Connect to Deepgram’s real-time transcription API
    dg_ws = await websockets.connect(
        "wss://api.deepgram.com/v1/listen?punctuate=true&interim_results=false",
        extra_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"}
    )

    async def receive_from_twilio():
        async for message in websocket:
            try:
                msg = json.loads(message)
                if msg["event"] == "media":
                    audio = base64.b64decode(msg["media"]["payload"])
                    await dg_ws.send(audio)
            except Exception as e:
                print("Media error:", e)

    async def handle_transcription():
        async for message in dg_ws:
            data = json.loads(message)
            if "channel" in data and data["channel"]["alternatives"]:
                transcript = data["channel"]["alternatives"][0]["transcript"]
                if transcript:
                    print(f"👤 Caller: {transcript}")
                    asyncio.create_task(respond_to(transcript, websocket))

    async def respond_to(text, twilio_ws):
        conversation_history.append({"role": "user", "content": text})

        print("🤖 GPT is thinking...")
        reply = ""
        response = await openai.ChatCompletion.acreate(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "You are a helpful voice assistant."}
            ] + conversation_history,
            stream=True
        )

        async for chunk in response:
            part = chunk["choices"][0].get("delta", {}).get("content", "")
            reply += part

        print(f"🧠 GPT: {reply}")
        conversation_history.append({"role": "assistant", "content": reply})

        speech_response = openai.audio.speech.create(
            model="tts-1",
            voice="nova",
            input=reply
        )

        filename = f"{uuid.uuid4()}.mp3"
        with open(filename, "wb") as f:
            f.write(speech_response.content)
        print(f"🔊 Saved: {filename}")
        print("⚠️ Please upload this MP3 and send Twilio a `<Play>` URL")

    await asyncio.gather(receive_from_twilio(), handle_transcription())


async def main():
    async with websockets.serve(handle_audio, "0.0.0.0", 8765, path="/ws"):
        print("🚀 Callbot is running at wss://0.0.0.0:8765/ws")
        await asyncio.Future()  # Keep running


if __name__ == "__main__":
    asyncio.run(main())
