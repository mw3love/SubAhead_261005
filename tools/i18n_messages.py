# 문구 원본: 키 → (한국어, 영어). $1, $2 … 는 자리표시자.
# 이 파일을 고친 뒤 `python3 tools/i18n_messages.py` 를 실행하면 extension-standalone/_locales/{ko,en}/messages.json 이 다시 만들어진다.
M = {
 "extName": ("SubAhead", "SubAhead"),
 "extDesc": ("영상 소리를 미리 받아 적어, 어디로 넘겨도 맞는 한국어 자막을 띄웁니다. 본인의 API 게이트웨이 주소와 키가 필요합니다.",
             "Transcribes a video's audio ahead of time so Korean subtitles stay in sync wherever you seek. Requires your own API gateway address and key."),
 "trackLabel": ("SubAhead", "SubAhead"),
 "cmdToggle": ("자막 켜기·끄기", "Toggle subtitles"),
 "cmdSize": ("자막 크기 바꾸기", "Change subtitle size"),
 "cmdEarlier": ("자막 0.5초 빠르게", "Subtitles 0.5s earlier"),
 "cmdLater": ("자막 0.5초 늦게", "Subtitles 0.5s later"),

 "stageDownload": ("영상 받는 중", "Downloading video"),
 "stageExtract": ("소리만 뽑는 중", "Extracting audio"),
 "stageUpload": ("올리는 중", "Uploading"),
 "stageTranscribe": ("받아 적는 중", "Transcribing"),
 "stagePreparing": ("준비 중", "Preparing"),
 "stepDownload": ("영상 받기", "Download video"),
 "stepExtract": ("소리만 뽑기", "Extract audio"),
 "stepUpload": ("올리기", "Upload"),
 "stepTranscribe": ("받아 적기", "Transcribe"),

 "errNO_KEY": ("먼저 API 게이트웨이 주소와 키를 넣어 주세요.", "Please enter your API gateway address and key first."),
 "errNO_VIDEO": ("이 페이지에서 영상을 찾지 못했어요. 영상을 잠깐 재생한 뒤 다시 눌러 주세요.", "No video found on this page. Play the video briefly, then try again."),
 "errBAD_KEY": ("키가 맞지 않아요. 키를 다시 확인해 주세요.", "The key was rejected. Please check your key."),
 "errNO_CREDIT": ("크레딧이 모자라요. 다음 달 충전 후 다시 시도해 주세요.", "Not enough credits. Please try again after your credits renew."),
 "errMEDIA_BLOCKED": ("이 사이트가 영상 받기를 막았어요. 이 사이트에서는 자막을 만들 수 없어요.", "This site blocked the video download, so subtitles can't be made here."),
 "errENCRYPTED": ("보호(암호화)된 영상이라 자막을 만들 수 없어요.", "This video is protected (encrypted), so subtitles can't be made."),
 "errLIVE": ("생방송은 아직 지원하지 않아요. 다시보기 영상에서 사용해 주세요.", "Live streams aren't supported yet. Please use it on a recorded video."),
 "errNETWORK": ("인터넷 연결이 끊겼거나 서버에 닿지 못했어요.", "The connection dropped or the server couldn't be reached."),
 "errFFMPEG": ("영상에서 소리를 뽑지 못했어요. 지원하지 않는 영상 형식일 수 있어요.", "Couldn't extract the audio. The video format may not be supported."),
 "errSTT_FAILED": ("받아 적기 서버에서 오류가 났어요. 잠시 뒤 다시 시도해 주세요.", "The transcription server returned an error. Please try again later."),
 "errUNKNOWN": ("알 수 없는 오류가 났어요.", "An unknown error occurred."),

 "jobMade": ("자막 $1줄을 만들었어요.", "Created $1 subtitle lines."),
 "jobLoaded": ("저장된 자막을 불러왔어요.", "Loaded saved subtitles."),
 "jobAttached": ("저장된 자막을 붙였어요.", "Applied saved subtitles."),

 "keyWrong": ("키가 맞지 않아요.", "The key is incorrect."),
 "keyCheckFailed": ("확인하지 못했어요 (서버 응답 $1).", "Couldn't verify the key (server response $1)."),
 "keyNoModel": ("이 서버에는 필요한 음성인식 모델(stt-async-v5)이 없어요.", "This server doesn't provide the required speech recognition model (stt-async-v5)."),
 "keyOffline": ("서버에 연결하지 못했어요. 주소와 인터넷 연결을 확인해 주세요.", "Couldn't reach the server. Please check the address and your internet connection."),
 "urlInvalid": ("주소가 올바르지 않아요. https:// 로 시작하는 주소를 넣어 주세요.", "The address isn't valid. Please enter an address starting with https://."),
 "keyEmpty": ("API 키를 넣어 주세요.", "Please enter an API key."),

 "toastTitle": ("SubAhead · $1", "SubAhead · $1"),
 "toastDone": ("완성", "Done"),
 "toastFailed": ("실패", "Failed"),
 "subsOn": ("자막 켬", "Subtitles on"),
 "subsOff": ("자막 끔", "Subtitles off"),
 "syncEarlier": ("자막 $1초 빠르게", "Subtitles $1s earlier"),
 "syncLater": ("자막 $1초 늦게", "Subtitles $1s later"),
 "syncTotal": ("합계 $1초", "Total $1s"),
 "syncReset": ("원래대로", "Back to original"),
 "fWheel": ("Alt+휠로 크기 조절", "Alt+wheel to resize"),
 "posNotice": ("자막 위치 $1", "Subtitle position $1"),

 "colorWhite": ("흰색", "White"), "colorYellow": ("노랑", "Yellow"), 
 "bgNone": ("없음", "None"), "bgDark": ("진하게", "Dark"), 
 "posBottom": ("아래", "Bottom"), 

 "popupKeyTitle": ("API 게이트웨이를 연결해 주세요", "Connect an API gateway"),
 "popupKeyDesc": ("음성인식 모델 stt-async-v5 를 제공하는 API 게이트웨이의 주소와 키를 넣어 주세요. 이 브라우저에만 저장돼요.", "Enter the address and key of an API gateway that provides the stt-async-v5 speech recognition model. They're stored only in this browser."),
 "baseUrlLabel": ("주소 (Base URL)", "Address (Base URL)"),
 "baseUrlPlaceholder": ("https://…/v1/gateway", "https://…/v1/gateway"),
 "apiKeyLabel": ("API 키", "API key"),
 "keyPlaceholder": ("API 키 붙여넣기", "Paste your API key"),
 "saveAndStart": ("저장하고 연결 확인", "Save and test connection"),
 "checking": ("확인 중…", "Checking…"),
 "noVideoTitle": ("영상을 찾지 못했어요", "No video found"),
 "noVideoDesc": ("영상이 있는 페이지에서 영상을 잠깐 재생한 뒤 다시 눌러 주세요.", "On a page with a video, play it briefly and try again."),
 "findAgain": ("다시 찾기", "Search again"),
 "liveTitle": ("생방송은 아직 지원하지 않아요", "Live streams aren't supported yet"),
 "liveDesc": ("끝이 정해지지 않은 영상이라 전체 자막을 미리 만들 수 없어요. 다시보기 영상에서 사용해 주세요.", "A live video has no fixed end, so full subtitles can't be made in advance. Please use it on a recorded video."),
 "savedSubs": ("저장된 자막", "Saved subtitles"),
 "available": ("있음", "Available"),
 "cost": ("비용", "Cost"),
 "free": ("들지 않아요", "Free"),
 "loadSubs": ("자막 불러오기", "Load subtitles"),
 "videoLength": ("영상 길이", "Video length"),
 "estCost": ("예상 비용", "Estimated cost"),
 "unknown": ("알 수 없음", "Unknown"),
 "aboutCredits": ("약 $1 크레딧", "About $1 credits"),
 "notEnough": ("남은 크레딧이 모자라요.", "Not enough credits left."),
 "makeAll": ("전체 자막 만들기", "Create full subtitles"),
 "pickVideo": ("자막을 만들 영상", "Video to subtitle"),
 "videoN": ("영상 $1", "Video $1"),
 "lastPlayed": ("방금 재생", "Last played"),
 "hasSubs": ("자막 있음", "Has subtitles"),
 "makingTitle": ("자막을 만들고 있어요", "Creating subtitles"),
 "elapsed": ("$1초 지났어요. 팝업을 닫아도 계속 진행돼요.", "$1s elapsed. It keeps going even if you close this popup."),
 "creditsUsed": ("$1 크레딧을 썼어요.", "Used $1 credits."),
 "seekAnywhere": ("영상을 아무 데나 넘겨 보세요.", "Try seeking anywhere in the video."),
 "retry": ("다시 시도", "Try again"),
 "rekey": ("연결 다시 설정", "Set up connection again"),
 "details": ("자세히", "Details"),
 "remaining": ("남은 $1", "$1 left"),
 "durH": ("$1시간 $2분", "$1h $2m"),
 "durM": ("$1분 $2초", "$1m $2s"),
 "durS": ("$1초", "$1s"),

 "previewText": ("자막은 이렇게 보여요", "This is how subtitles look"),
 "fSize": ("크기", "Size"),
 "savedEmpty": ("아직 저장된 자막이 없어요.", "No saved subtitles yet."),
 "lines": ("$1줄", "$1 lines"),
 "syncShort": ("싱크 $1초", "Sync $1s"),
 "deleteAria": ("$1 자막 지우기", "Delete subtitles for $1"),
 "clearAll": ("모두 지우기", "Delete all"),
 "clearConfirm": ("정말 모두 지울까요? 한 번 더 누르세요", "Delete everything? Click again to confirm"),
 "apiTitle": ("API 게이트웨이", "API gateway"),
 "keySaved": ("연결됨: $1 · 키 ••••$2", "Connected: $1 · key ••••$2"),
 "keyNone": ("아직 연결된 게이트웨이가 없어요.", "No gateway connected yet."),
 "newKeyPlaceholder": ("새 키 (바꿀 때만 입력)", "New key (only to change it)"),
 "keySavedOk": ("✓ 저장했어요.", "✓ Saved."),
 "tabSubs": ("자막", "Subtitles"),
 "tabLook": ("모양", "Style"),
 "tabSettings": ("설정", "Settings"),
 "preview": ("미리보기", "Preview"),
 "fColor": ("색", "Color"),
 "fBg": ("배경", "Background"),
 "bgHalf": ("반투명", "Semi-transparent"),
 "bgDark": ("진하게", "Dark"),
 "toggleSubs": ("자막 켜기·끄기", "Show/hide subtitles"),
 "remake": ("다시 만들기", "Create again"),
 "remakeCost": ("다시 만들기 (약 $1)", "Create again (~$1)"),
 "footNote": ("영상 위에서 Alt+휠로 크기, Alt+드래그로 위치를 바꿀 수 있어요", "On the video, Alt+wheel resizes and Alt+drag moves subtitles"),
 "change": ("변경", "Change"),
 "shortcuts": ("단축키", "Shortcuts"),
 "shortcutsLink": ("보기·바꾸기", "View/change"),
 "sizeValue": ("자막 크기 $1", "Subtitle size $1"),
 "savedCount": ("$1개 · $2", "$1 saved · $2"),
}

if __name__ == "__main__":
    import json, os, re
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension-standalone", "_locales")
    for i, lang in enumerate(["ko", "en"]):
        out = {}
        for key, texts in M.items():
            text = texts[i]
            nums = sorted(set(re.findall(r"\$(\d)", text)))
            entry = {"message": re.sub(r"\$(\d)", r"$P\1$", text)}
            if nums:
                entry["placeholders"] = {"p" + n: {"content": "$" + n} for n in nums}
            out[key] = entry
        os.makedirs(os.path.join(here, lang), exist_ok=True)
        with open(os.path.join(here, lang, "messages.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write("\n")
    print("messages:", len(M))
