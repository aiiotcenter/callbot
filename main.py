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


async def respond_to(text, twilio_ws):
    conversation_history.append({"role": "user", "content": text})
    print("🤖 GPT is thinking...")

    reply = ""
    try:
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

        # Convert to speech
        speech_response = openai.audio.speech.create(
            model="tts-1",
            voice="nova",
            input=reply
        )

        filename = f"{uuid.uuid4()}.mp3"
        with open(filename, "wb") as f:
            f.write(speech_response.content)
        print(f"🔊 MP3 saved as: {filename}")
        print("⚠️ Send this MP3 back to the caller using <Play> TwiML.")

    except Exception as e:
        print("🔴 Error in GPT response:", str(e))


async def handle_audio(websocket):
    print("📞 New WebSocket connection established")
    await websocket.send("✅ Connected to Callbot WebSocket server")

    try:
        dg_ws = await websockets.connect(
            "wss://api.deepgram.com/v1/listen?punctuate=true&interim_results=false",
            extra_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"}
        )
        print("✅ Connected to Deepgram")

        async def receive_from_twilio():
            try:
                async for message in websocket:
                    print("📥 Message from client:", message[:100])
                    msg = json.loads(message)

                    if msg.get("event") == "media":
                        audio = base64.b64decode(msg["media"]["payload"])
                        await dg_ws.send(audio)
                        print("🔁 Audio sent to Deepgram")
            except websockets.exceptions.ConnectionClosed as e:
                print("🔌 Client disconnected:", e.code, e.reason)
            except Exception as e:
                print("🔴 Error in receive_from_twilio:", str(e))

        async def handle_transcription():
            try:
                async for message in dg_ws:
                    print("📝 From Deepgram:", message[:100])
                    data = json.loads(message)
                    if "channel" in data and data["channel"]["alternatives"]:
                        transcript = data["channel"]["alternatives"][0]["transcript"]
                        if transcript:
                            print(f"👤 Caller said: {transcript}")
                            asyncio.create_task(respond_to(transcript, websocket))
            except Exception as e:
                print("🔴 Error in handle_transcription:", str(e))

        await asyncio.gather(receive_from_twilio(), handle_transcription())

    except Exception as e:
        print("🔥 Fatal error in handle_audio:", str(e))

    print("❌ WebSocket session ended.")


async def main():
    print("🚀 Starting Callbot server on ws://0.0.0.0:8765")
    async with websockets.serve(handle_audio, "0.0.0.0", 8765):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print("🧨 Server crash:", str(e))
