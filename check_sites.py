import asyncio
from datetime import datetime
import json
import os
import gspread
from google.oauth2.service_account import Credentials
from telethon import TelegramClient
from telethon.sessions import StringSession

# ==================== 1. ទាញយកតាមឈ្មោះ Secret ក្នុង GitHub ====================
API_ID = int(os.environ.get("TELEGRAM_API_ID"))
API_HASH = os.environ.get("TELEGRAM_API_HASH")
STRING_SESSION = os.environ.get("TELEGRAM_SESSION")
BOT_USERNAME = os.environ.get("BOT_USERNAME")
SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID")
GCP_SA_KEY = os.environ.get("GCP_SA_KEY")

SHEET_NAME = "BTS_Site_Monitoring"  # ឈ្មោះ Google Sheet

# រៀបចំ Google Sheet Connection
creds_dict = json.loads(GCP_SA_KEY)
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
CREDS = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
GS_CLIENT = gspread.authorize(CREDS)
sheet = GS_CLIENT.open_by_key(SPREADSHEET_ID).sheet1

# ==================== 2. បញ្ជីកូដសាយ ====================
SITE_CODES = [
    "CHA0001",
    "CHA0002",
    "CHA0408",
    "CHA0763",
]  # បញ្ចូលកូដសាយរបស់អ្នកនៅទីនេះ


# ==================== 3. មុខងារដំណើរការ ====================
async def run_monitoring():
    print(
        f"⏰ [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ចាប់ផ្តើមពិនិត្យទិន្នន័យ..."
    )

    async with TelegramClient(
        StringSession(STRING_SESSION), API_ID, API_HASH
    ) as client:
        for site in SITE_CODES:
            print(f"🔍 កំពុងសួរកូដសាយ: {site}")
            try:
                async with client.conversation(BOT_USERNAME, timeout=15) as conv:
                    await conv.send_message(f"/bts {site}")
                    response = await conv.get_response()
                    reply_text = response.text or response.caption or ""

                    # បើ No data -> រំលង
                    if (
                        "no data available" in reply_text.lower()
                        or "no data" in reply_text.lower()
                    ):
                        print(f"⚠️ សាយ {site}: គ្មានទិន្នន័យ -> រំលង")
                        continue

                    # បើមានទិន្នន័យ -> រក្សាទុកក្នុង Google Sheet
                    current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    row_data = [current_time, site, reply_text]
                    sheet.append_row(row_data)
                    print(f"✅ សាយ {site}: រក្សាទុកទិន្នន័យរួចរាល់!")

            except asyncio.TimeoutError:
                print(f"❌ សាយ {site}: Timeout")
            except Exception as e:
                print(f"❌ សាយ {site} មានបញ្ហា: {e}")

            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(run_monitoring())
