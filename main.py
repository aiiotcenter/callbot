# test_ws.py
import asyncio
import websockets

async def echo(websocket, path):
    print("📞 Client connected")
    try:
        async for message in websocket:
            print(f"Received: {message}")
            await websocket.send(f"Echo: {message}")
    except Exception as e:
        print("🔴 Error:", e)

async def main():
    async with websockets.serve(echo, "0.0.0.0", 8765):
        print("✅ Echo server running at ws://0.0.0.0:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
