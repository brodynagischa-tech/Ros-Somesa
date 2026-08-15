"""
check_sites.py
ដំណើរការស្វ័យប្រវត្តិ៖ ផ្ញើ /bts CHA0001 ... CHA0500 ទៅ Bot B ម្តងមួយៗតាមរយៈគណនី Telegram
ផ្ទាល់ខ្លួន (userbot) រួចកត់ត្រាលទ្ធផលទៅ Google Sheet។ រត់ដោយ GitHub Actions តាមកាលវិភាគ។
"""

import os
import time
import json
from datetime import datetime

from telethon.sync import TelegramClient
from telethon.sessions import StringSession

import gspread
from google.oauth2.service_account import Credentials

# ============================================================
# CONFIG - តម្លៃភាគច្រើនមកពី GitHub Secrets (environment variables)
# ============================================================
API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION_STRING = os.environ["TELEGRAM_SESSION"]
BOT_USERNAME = os.environ["BOT_USERNAME"]          # ឈ្មោះ Bot B ដោយគ្មាន @ ឧ. "SomeStatusBot"
SPREADSHEET_ID = os.environ["SPREADSHEET_ID"]
GOOGLE_CREDS_JSON = os.environ["GCP_SA_KEY"]  # Service account JSON ទាំងមូល (គ្មាន encode)

CHECK_COMMAND = "/bts"
SHEET_QUEUE = "Queue"
SHEET_OFFLINE = "OfflineSites"
NO_DATA_TEXT = "No data available"
REPLY_TIMEOUT_SEC = 150    # រង់ចាំចម្លើយប៉ុន្មានវិនាទីមុននឹងចាត់ទុកថាគ្មានចម្លើយ (Bot B អាចយឺត ១-២ នាទី ព្រោះមានគេសួរដែរក្នុងគ្រុប)
POLL_INTERVAL_SEC = 5      # ញែកមើលចម្លើយរៀងរាល់ប៉ុន្មានវិនាទី
DELAY_BETWEEN_SITES_SEC = 4  # ចន្លោះពេលរវាងសំណួរនីមួយៗ ដើម្បីជៀសវាងការរឹតត្បិតរបស់ Telegram


# ============================================================
# Google Sheets helpers
# ============================================================
def get_spreadsheet():
    creds_dict = json.loads(GOOGLE_CREDS_JSON)
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open_by_key(SPREADSHEET_ID)


def get_or_create_worksheet(sh, title, header):
    try:
        ws = sh.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=title, rows=1000, cols=len(header))
        ws.append_row(header)
    return ws


def load_queue(sh):
    """អាន site code ពីជួរឈរ A របស់ Sheet 'Queue' (ជួរដេកទី 2 ចុះក្រោម)។
    ត្រូវការឲ្យអ្នកប្រើ paste កូដ (មួយកូដក្នុងមួយជួរដេក) ចូលជួរឈរ A ដោយផ្ទាល់ជាមុន។"""
    ws = get_or_create_worksheet(sh, SHEET_QUEUE, ["Code", "Status", "Result", "CheckedAt"])
    rows = ws.get_all_values()
    codes = []
    for row_num, row in enumerate(rows[1:], start=2):  # រំលងបន្ទាត់ header
        if row and row[0].strip():
            codes.append((row_num, row[0].strip()))
    return ws, codes


# ============================================================
# Telegram helpers
# ============================================================
def wait_for_reply(client, entity, sent_message):
    """ត្រួតពិនិត្យរកមើលសារថ្មីដែលចូលមកបន្ទាប់ពីសារយើងផ្ញើ (min_id) រហូតដល់ REPLY_TIMEOUT_SEC។
    ដោយសារនេះជាឆាតឯកជនមានតែយើងនិង Bot B ២នាក់ សារថ្មីណាមួយចូលមកក្រោយ ត្រូវតែជាចម្លើយពី Bot B។"""
    deadline = time.time() + REPLY_TIMEOUT_SEC
    while time.time() < deadline:
        for m in client.get_messages(entity, min_id=sent_message.id, limit=10):
            if not m.out:  # សារចូល (មិនមែនសារយើងផ្ញើ)
                return m.text or ""
        time.sleep(POLL_INTERVAL_SEC)
    return None


# ============================================================
# Main
# ============================================================
def main():
    sh = get_spreadsheet()
    queue_ws, codes = load_queue(sh)
    offline_ws = get_or_create_worksheet(sh, SHEET_OFFLINE, ["Code", "CheckedAt"])

    if not codes:
        print("Queue sheet ទទេ - សូម paste site code ចូលជួរឈរ A សិន (ចាប់ពីជួរដេកទី 2)")
        return

    online = offline = no_resp = 0

    with TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH) as client:
        entity = client.get_entity(BOT_USERNAME)

        for row_num, code in codes:
            sent = client.send_message(entity, f"{CHECK_COMMAND} {code}")

            reply_text = wait_for_reply(client, entity, sent)
            now = datetime.now().isoformat()

            if reply_text is None:
                result = "NoResponse"
                no_resp += 1
                offline_ws.append_row([code, now])
            elif NO_DATA_TEXT in reply_text:
                result = "Offline"
                offline += 1
                offline_ws.append_row([code, now])
            else:
                result = "Online"
                online += 1

            queue_ws.update(f"B{row_num}:D{row_num}", [["Done", result, now]])
            print(f"{code}: {result}")

            time.sleep(DELAY_BETWEEN_SITES_SEC)

    print(f"\nរួចរាល់! Online={online}  Offline={offline}  NoResponse={no_resp}")


if __name__ == "__main__":
    main()
