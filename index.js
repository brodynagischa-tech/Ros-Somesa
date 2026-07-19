// GIS Test — កម្មវិធីជជែក (Expo / React Native)
//
// ត្រូវការ packages បន្ថែម:
//   npx expo install react-native-safe-area-context socket.io-client expo-image-picker expo-document-picker expo-file-system expo-sharing

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Modal,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { io } from 'socket.io-client';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---- កំណត់ត្រង់នេះ ----
const SERVER_URL = 'https://gis-test-serve.onrender.com';

const KH_PHONE_REGEX = /^[0-9]{8,10}$/;
function isValidKhmerPhone(phone) {
  const cleaned = phone.replace(/[\s-]/g, '').replace(/^\+/, '');
  const digitsOnly = cleaned.replace(/^855/, '').replace(/^0/, '');
  return KH_PHONE_REGEX.test(digitsOnly);
}

const PALETTES = {
  light: {
    bg: '#f2f2f7',
    headerBg: '#ffffff',
    headerText: '#000000',
    bubbleTheirs: '#e5e5ea',
    bubbleTheirsText: '#000000',
    inputBg: '#f2f2f7',
    inputText: '#000000',
    inputRowBg: '#ffffff',
    border: '#c6c6c8',
    menuBg: '#ffffff',
    menuText: '#000000',
    subtleText: '#666666',
  },
  dark: {
    bg: '#0e0e11',
    headerBg: '#1c1c1f',
    headerText: '#ffffff',
    bubbleTheirs: '#2c2c30',
    bubbleTheirsText: '#ffffff',
    inputBg: '#2c2c30',
    inputText: '#ffffff',
    inputRowBg: '#1c1c1f',
    border: '#3a3a3d',
    menuBg: '#1c1c1f',
    menuText: '#ffffff',
    subtleText: '#9a9a9e',
  },
};

export default function App() {
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingSavedLogin, setCheckingSavedLogin] = useState(true);

  // On app start, see if we already have a saved name/phone from last time —
  // if so, log the user straight in instead of asking again.
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem('gis_test_login');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed?.name && parsed?.phone) {
            setName(parsed.name);
            setPhone(parsed.phone);
            setLoggedIn(true);
          }
        }
      } catch (e) {
        // no saved login, or storage unavailable — just show the login screen
      } finally {
        setCheckingSavedLogin(false);
      }
    })();
  }, []);

  const [messagesByRoom, setMessagesByRoom] = useState({ general: [] });
  const [rooms, setRooms] = useState([{ id: 'general', name: 'ទូទៅ (General)' }]);
  const [currentRoomId, setCurrentRoomId] = useState('general');

  const [draft, setDraft] = useState('');
  const [connectionState, setConnectionState] = useState('connecting');
  const [sendingAttachment, setSendingAttachment] = useState(false);
  const socketRef = useRef(null);
  const listRef = useRef(null);

  const [menuVisible, setMenuVisible] = useState(false);
  const [profileVisible, setProfileVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [groupsVisible, setGroupsVisible] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupMembers, setNewGroupMembers] = useState('');
  const [darkMode, setDarkMode] = useState(false);
  const c = darkMode ? PALETTES.dark : PALETTES.light;

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordingRef = useRef(null);
  const recordTimerRef = useRef(null);
  const [playingId, setPlayingId] = useState(null);
  const soundRef = useRef(null);

  useEffect(() => {
    if (!loggedIn) return;

    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[socket] connected', socket.id);
      setConnectionState('connected');
      socket.emit('identify', { phone });
    });
    socket.on('disconnect', (reason) => {
      console.log('[socket] disconnected:', reason);
      setConnectionState('disconnected');
    });
    socket.on('connect_error', (err) => {
      // This is the actual reason the server refused the connection —
      // if images/files never send, check this message first (Metro/adb logcat).
      console.log('[socket] connect_error:', err?.message || err);
      setConnectionState('error');
    });

    socket.on('room list', (list) => setRooms(list));

    socket.on('room history', ({ roomId, history }) => {
      setMessagesByRoom((prev) => ({ ...prev, [roomId]: history }));
    });

    socket.on('room created', ({ id, name: roomName }) => {
      setCurrentRoomId(id);
      setGroupsVisible(false);
    });

    socket.on('join denied', () => {
      Alert.alert('មិនអាចចូលបានទេ', 'អ្នកមិនមែនជាសមាជិកក្រុមនេះទេ។');
    });

    socket.on('chat message', (msg) => {
      setMessagesByRoom((prev) => {
        const list = prev[msg.roomId] || [];
        return { ...prev, [msg.roomId]: [...list, msg] };
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [loggedIn]);

  const handleLogin = useCallback(() => {
    if (!name.trim()) {
      setLoginError('សូមបញ្ចូលឈ្មោះរបស់អ្នក');
      return;
    }
    if (!isValidKhmerPhone(phone)) {
      setLoginError('សូមបញ្ចូលលេខទូរស័ព្ទឱ្យត្រឹមត្រូវ (ឧ. 012 345 678)');
      return;
    }
    setLoginError('');
    setLoggedIn(true);
    AsyncStorage.setItem('gis_test_login', JSON.stringify({ name: name.trim(), phone: phone.trim() })).catch(() => {});
  }, [name, phone]);

  // Sends a chat-message payload and waits (up to 15s) for the server's
  // acknowledgement. Throws with a clear reason if the server rejects it
  // or never responds — callers show that reason to the user instead of
  // failing silently.
  const emitChatMessage = useCallback((payload) => {
    return new Promise((resolve, reject) => {
      const sock = socketRef.current;
      if (!sock || !sock.connected) {
        reject(new Error('មិនទាន់ភ្ជាប់ជាមួយ Server (Socket disconnected)'));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error('Server មិនឆ្លើយតបក្នុងរយៈពេល 15 វិនាទី (Timeout)'));
      }, 15000);

      sock.emit('chat message', payload, (ack) => {
        clearTimeout(timer);
        if (ack && ack.ok) resolve(ack);
        else reject(new Error(ack?.error || 'Server បដិសេធសារនេះ'));
      });
    });
  }, []);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || connectionState !== 'connected') return;
    setDraft('');
    try {
      await emitChatMessage({ roomId: currentRoomId, text, sender: phone, senderName: name });
    } catch (e) {
      Alert.alert('ផ្ញើសារមិនចេញ', e.message);
    }
  }, [draft, connectionState, phone, name, currentRoomId, emitChatMessage]);

  const sendImageAsset = useCallback(
    async (asset) => {
      if (!asset?.base64) {
        Alert.alert('មានបញ្ហា', 'មិនអាចអានទិន្នន័យរូបភាពនេះបានទេ (គ្មាន base64) សូមសាកល្បងរូបផ្សេង។');
        return;
      }
      const mime = asset.mimeType || 'image/jpeg';
      const dataUri = `data:${mime};base64,${asset.base64}`;
      if (dataUri.length > 20 * 1024 * 1024) {
        Alert.alert('រូបភាពធំពេក', 'សូមជ្រើសរើសរូបភាពតូចជាងនេះ។');
        return;
      }
      setSendingAttachment(true);
      try {
        await emitChatMessage({ roomId: currentRoomId, image: dataUri, sender: phone, senderName: name });
      } catch (e) {
        Alert.alert('ផ្ញើរូបភាពមិនចេញ', e.message);
      } finally {
        setSendingAttachment(false);
      }
    },
    [phone, name, currentRoomId, emitChatMessage]
  );

  const takePhoto = useCallback(async () => {
    if (connectionState !== 'connected') {
      Alert.alert('មិនទាន់ភ្ជាប់', 'សូមរង់ចាំការតភ្ជាប់ជាមួយ Server សិន។');
      return;
    }
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('ត្រូវការសិទ្ធិប្រើកាមេរ៉ា', 'សូមចូល Settings ទូរស័ព្ទ → Apps → GIS Test → Permissions → បើកអនុញ្ញាត Camera');
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({ quality: 0.4, base64: true, allowsEditing: false });
      if (result.canceled) return;
      await sendImageAsset(result.assets?.[0]);
    } catch (e) {
      Alert.alert('កាមេរ៉ាមានបញ្ហា', String(e?.message || e));
    }
  }, [connectionState, sendImageAsset]);

  const pickFromGallery = useCallback(async () => {
    if (connectionState !== 'connected') {
      Alert.alert('មិនទាន់ភ្ជាប់', 'សូមរង់ចាំការតភ្ជាប់ជាមួយ Server សិន។');
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('ត្រូវការសិទ្ធិចូលមើលរូបភាព', 'សូមចូល Settings ទូរស័ព្ទ → Apps → GIS Test → Permissions → បើកអនុញ្ញាត Photos');
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.4,
        base64: true,
        allowsEditing: false,
      });
      if (result.canceled) return;
      await sendImageAsset(result.assets?.[0]);
    } catch (e) {
      Alert.alert('Gallery មានបញ្ហា', String(e?.message || e));
    }
  }, [connectionState, sendImageAsset]);

  const pickAndSendFile = useCallback(async () => {
    if (connectionState !== 'connected') {
      Alert.alert('មិនទាន់ភ្ជាប់', 'សូមរង់ចាំការតភ្ជាប់ជាមួយ Server សិន។');
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset) return;

    if ((asset.size || 0) > 15 * 1024 * 1024) {
      Alert.alert('ឯកសារធំពេក', 'សូមផ្ញើឯកសារតូចជាង 15MB។');
      return;
    }

    try {
      setSendingAttachment(true);
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      await emitChatMessage({
        roomId: currentRoomId,
        fileData: base64,
        fileName: asset.name,
        fileMime: asset.mimeType || 'application/octet-stream',
        sender: phone,
        senderName: name,
      });
    } catch (e) {
      Alert.alert('ផ្ញើឯកសារមិនចេញ', String(e?.message || e));
    } finally {
      setSendingAttachment(false);
    }
  }, [connectionState, phone, name, currentRoomId, emitChatMessage]);

  const startRecording = useCallback(async () => {
    if (connectionState !== 'connected') {
      Alert.alert('មិនទាន់ភ្ជាប់', 'សូមរង់ចាំការតភ្ជាប់ជាមួយ Server សិន។');
      return;
    }
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('ត្រូវការសិទ្ធិប្រើមីក្រូហ្វូន', 'សូមចូល Settings ទូរស័ព្ទ → Apps → GIS Test → Permissions → បើកអនុញ្ញាត Microphone');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch (e) {
      Alert.alert('មិនអាចថតសំឡេងបានទេ', String(e?.message || e));
    }
  }, [connectionState]);

  const cancelRecording = useCallback(async () => {
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
    setRecordSeconds(0);
    try {
      await recordingRef.current?.stopAndUnloadAsync();
    } catch (e) {
      // already stopped — ignore
    }
    recordingRef.current = null;
  }, []);

  const stopRecordingAndSend = useCallback(async () => {
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
    const durationSeconds = recordSeconds;
    setRecordSeconds(0);

    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return;

    if (durationSeconds < 1) {
      // too short to be a real message — just discard quietly
      try {
        await recording.stopAndUnloadAsync();
      } catch (e) {}
      return;
    }

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setSendingAttachment(true);
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      await emitChatMessage({
        roomId: currentRoomId,
        audioData: base64,
        audioMime: 'audio/m4a',
        audioDuration: durationSeconds,
        sender: phone,
        senderName: name,
      });
    } catch (e) {
      Alert.alert('ផ្ញើសំឡេងមិនចេញ', String(e?.message || e));
    } finally {
      setSendingAttachment(false);
    }
  }, [recordSeconds, phone, name, currentRoomId, emitChatMessage]);

  const playAudioMessage = useCallback(
    async (item) => {
      try {
        // Tap the currently-playing bubble again to stop it.
        if (playingId === item.id) {
          await soundRef.current?.stopAsync();
          await soundRef.current?.unloadAsync();
          soundRef.current = null;
          setPlayingId(null);
          return;
        }
        // Switching to a different bubble — stop whatever was playing first.
        if (soundRef.current) {
          await soundRef.current.stopAsync();
          await soundRef.current.unloadAsync();
          soundRef.current = null;
        }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
        const dataUri = `data:${item.audioMime || 'audio/m4a'};base64,${item.audioData}`;
        const { sound } = await Audio.Sound.createAsync({ uri: dataUri }, { shouldPlay: true });
        soundRef.current = sound;
        setPlayingId(item.id);
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.didJustFinish) {
            setPlayingId(null);
            sound.unloadAsync();
            soundRef.current = null;
          }
        });
      } catch (e) {
        Alert.alert('លេងសំឡេងមិនចេញ', String(e?.message || e));
      }
    },
    [playingId]
  );

  const openReceivedFile = useCallback(async (item) => {
    try {
      const path = `${FileSystem.cacheDirectory}${item.fileName || 'file'}`;
      await FileSystem.writeAsStringAsync(path, item.fileData, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: item.fileMime });
      }
    } catch (e) {
      Alert.alert('មានបញ្ហា', 'មិនអាចបើកឯកសារនេះបានទេ។');
    }
  }, []);

  const handleAttachPress = useCallback(() => {
    if (sendingAttachment) return;
    if (connectionState !== 'connected') {
      Alert.alert('មិនទាន់ភ្ជាប់', 'សូមរង់ចាំការតភ្ជាប់ជាមួយ Server សិន។');
      return;
    }
    Alert.alert(
      'ផ្ញើ',
      'ជ្រើសរើសប្រភេទ',
      [
        { text: 'ថតរូបថ្មី', onPress: takePhoto },
        { text: 'ជ្រើសរូបពី Gallery', onPress: pickFromGallery },
        { text: 'ផ្ញើឯកសារ (PDF/Word/Excel)', onPress: pickAndSendFile },
        { text: 'បោះបង់', style: 'cancel' },
      ],
      { cancelable: true }
    );
  }, [connectionState, sendingAttachment, takePhoto, pickFromGallery, pickAndSendFile]);

  const createGroup = useCallback(() => {
    if (!newGroupName.trim()) return;
    if (connectionState !== 'connected') {
      Alert.alert('មិនទាន់ភ្ជាប់', 'សូមរង់ចាំការតភ្ជាប់ជាមួយ Server សិន។');
      return;
    }
    const memberPhones = newGroupMembers
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    socketRef.current.emit('create room', { name: newGroupName.trim(), memberPhones });
    setNewGroupName('');
    setNewGroupMembers('');
  }, [newGroupName, newGroupMembers, connectionState]);

  const switchRoom = useCallback(
    (roomId) => {
      setCurrentRoomId(roomId);
      setGroupsVisible(false);
      if (!messagesByRoom[roomId] && socketRef.current) {
        socketRef.current.emit('join room', roomId);
      }
    },
    [messagesByRoom]
  );

  const renderStatusBanner = () => {
    if (connectionState === 'connected') return null;
    const labels = {
      connecting: 'កំពុងភ្ជាប់...',
      disconnected: 'ដាច់ការតភ្ជាប់ — កំពុងភ្ជាប់ឡើងវិញ...',
      error: 'មានបញ្ហាតភ្ជាប់ — កំពុងព្យាយាមម្តងទៀត...',
    };
    return (
      <View style={styles.banner}>
        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
        <Text style={styles.bannerText}>{labels[connectionState]}</Text>
      </View>
    );
  };

  if (checkingSavedLogin) {
    return (
      <View style={[styles.root, styles.flex, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#007aff" />
      </View>
    );
  }

  if (!loggedIn) {
    return (
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <KeyboardAvoidingView style={[styles.flex, styles.loginContainer]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Image source={require('./assets/logo-inapp.png')} style={styles.loginLogo} resizeMode="contain" />
          <Text style={styles.loginTitle}>GIS Test</Text>
          <Text style={styles.loginSubtitle}>បញ្ចូលឈ្មោះ និងលេខទូរស័ព្ទដើម្បីចូលជជែក</Text>

          <TextInput
            style={styles.phoneInput}
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (loginError) setLoginError('');
            }}
            placeholder="ឈ្មោះរបស់អ្នក"
            placeholderTextColor="#8e8e93"
            maxLength={40}
          />
          <TextInput
            style={[styles.phoneInput, { marginTop: 12 }]}
            value={phone}
            onChangeText={(t) => {
              setPhone(t);
              if (loginError) setLoginError('');
            }}
            placeholder="012 345 678"
            placeholderTextColor="#8e8e93"
            keyboardType="phone-pad"
            maxLength={15}
          />
          {loginError ? <Text style={styles.errorText}>{loginError}</Text> : null}

          <TouchableOpacity style={styles.loginBtn} onPress={handleLogin}>
            <Text style={styles.loginBtnText}>ចូល</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </View>
    );
  }

  const currentRoom = rooms.find((r) => r.id === currentRoomId);
  const messages = messagesByRoom[currentRoomId] || [];

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.bg }]}>
      <View style={[styles.header, { backgroundColor: c.headerBg, borderBottomColor: c.border }]}>
        <TouchableOpacity onPress={() => setMenuVisible(true)} style={styles.menuBtn}>
          <Text style={[styles.menuIcon, { color: c.headerText }]}>☰</Text>
        </TouchableOpacity>
        <View style={styles.headerTitleRow}>
          <Image source={require('./assets/logo-inapp.png')} style={styles.headerLogo} resizeMode="contain" />
          <Text style={[styles.headerTitle, { color: c.headerText }]} numberOfLines={1}>
            {currentRoom ? currentRoom.name : 'GIS Test'}
          </Text>
        </View>
        <TouchableOpacity onPress={() => setGroupsVisible(true)} style={styles.menuBtn}>
          <Text style={[styles.menuIcon, { color: c.headerText, fontSize: 18 }]}>👥</Text>
        </TouchableOpacity>
      </View>

      {renderStatusBanner()}

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item, idx) => item.id ?? String(idx)}
          renderItem={({ item }) => {
            const isMine = item.sender === phone;
            const displayName = item.senderName || item.sender;
            return (
              <View
                style={[
                  styles.bubble,
                  isMine ? styles.bubbleMine : { backgroundColor: c.bubbleTheirs, alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
                ]}
              >
                <Text style={[styles.bubbleSender, !isMine && { color: c.subtleText }]}>{displayName}</Text>
                {item.image ? <Image source={{ uri: item.image }} style={styles.bubbleImage} resizeMode="cover" /> : null}
                {item.fileData ? (
                  <TouchableOpacity style={styles.fileChip} onPress={() => openReceivedFile(item)}>
                    <Text style={styles.fileChipIcon}>📄</Text>
                    <Text style={[styles.fileChipName, !isMine && { color: c.bubbleTheirsText }]} numberOfLines={1}>
                      {item.fileName}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {item.audioData ? (
                  <TouchableOpacity style={styles.fileChip} onPress={() => playAudioMessage(item)}>
                    <Text style={styles.fileChipIcon}>{playingId === item.id ? '⏹️' : '▶️'}</Text>
                    <Text style={[styles.fileChipName, !isMine && { color: c.bubbleTheirsText }]}>
                      សារសំឡេង · {Math.floor((item.audioDuration || 0) / 60)}:
                      {String((item.audioDuration || 0) % 60).padStart(2, '0')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {item.text ? <Text style={[styles.bubbleText, !isMine && { color: c.bubbleTheirsText }]}>{item.text}</Text> : null}
              </View>
            );
          }}
          contentContainerStyle={styles.listContent}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={10}
          removeClippedSubviews={Platform.OS === 'android'}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        />

        <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 10), backgroundColor: c.inputRowBg, borderTopColor: c.border }]}>
          <TouchableOpacity style={[styles.attachBtn, { backgroundColor: c.inputBg }]} onPress={handleAttachPress} disabled={sendingAttachment || isRecording}>
            {sendingAttachment ? <ActivityIndicator size="small" color="#007aff" /> : <Text style={styles.attachBtnText}>📎</Text>}
          </TouchableOpacity>
          {isRecording ? (
            <View style={[styles.recordingRow, { backgroundColor: c.inputBg }]}>
              <View style={styles.recordingDot} />
              <Text style={[styles.recordingTime, { color: c.inputText }]}>
                {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, '0')}
              </Text>
              <TouchableOpacity onPress={cancelRecording} style={styles.recordingCancelBtn}>
                <Text style={styles.recordingCancelText}>បោះបង់</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TextInput
              style={[styles.input, { backgroundColor: c.inputBg, color: c.inputText }]}
              value={draft}
              onChangeText={setDraft}
              placeholder="វាយសារនៅទីនេះ"
              placeholderTextColor="#8e8e93"
              multiline
              maxLength={2000}
            />
          )}

          {isRecording ? (
            <TouchableOpacity style={styles.sendBtn} onPress={stopRecordingAndSend}>
              <Text style={styles.sendBtnText}>✓</Text>
            </TouchableOpacity>
          ) : draft.trim() ? (
            <TouchableOpacity style={styles.sendBtn} onPress={sendMessage}>
              <Text style={styles.sendBtnText}>ផ្ញើ</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.attachBtn, { backgroundColor: c.inputBg }]}
              onPress={startRecording}
              disabled={sendingAttachment}
            >
              <Text style={styles.attachBtnText}>🎤</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* --- Side menu --- */}
      <Modal visible={menuVisible} animationType="slide" transparent onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setMenuVisible(false)}>
          <View style={[styles.sideMenu, { backgroundColor: c.menuBg, paddingTop: insets.top + 16 }]}>
            <Text style={[styles.sideMenuName, { color: c.menuText }]}>{name}</Text>
            <View style={[styles.sideMenuDivider, { backgroundColor: c.border, marginTop: 12 }]} />
            <TouchableOpacity
              style={styles.sideMenuItem}
              onPress={() => {
                setMenuVisible(false);
                setProfileVisible(true);
              }}
            >
              <Text style={[styles.sideMenuItemText, { color: c.menuText }]}>👤  ព័ត៌មានផ្ទាល់ខ្លួន</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sideMenuItem}
              onPress={() => {
                setMenuVisible(false);
                setGroupsVisible(true);
              }}
            >
              <Text style={[styles.sideMenuItemText, { color: c.menuText }]}>👥  ក្រុមជជែក (Groups)</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sideMenuItem}
              onPress={() => {
                setMenuVisible(false);
                setSettingsVisible(true);
              }}
            >
              <Text style={[styles.sideMenuItemText, { color: c.menuText }]}>⚙️  ការកំណត់</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sideMenuItem}
              onPress={() => {
                setMenuVisible(false);
                AsyncStorage.removeItem('gis_test_login').catch(() => {});
                setLoggedIn(false);
                setName('');
                setPhone('');
              }}
            >
              <Text style={[styles.sideMenuItemText, { color: '#ff3b30' }]}>🚪  ចាកចេញ (Logout)</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* --- Profile --- */}
      <Modal visible={profileVisible} animationType="fade" transparent onRequestClose={() => setProfileVisible(false)}>
        <View style={styles.centerOverlay}>
          <View style={[styles.centerCard, { backgroundColor: c.menuBg }]}>
            <Text style={[styles.centerCardTitle, { color: c.menuText }]}>ព័ត៌មានផ្ទាល់ខ្លួន</Text>
            <View style={styles.profileRow}>
              <Text style={[styles.profileLabel, { color: c.subtleText }]}>ឈ្មោះ</Text>
              <Text style={[styles.profileValue, { color: c.menuText }]}>{name}</Text>
            </View>
            <View style={styles.profileRow}>
              <Text style={[styles.profileLabel, { color: c.subtleText }]}>លេខទូរស័ព្ទ</Text>
              <Text style={[styles.profileValue, { color: c.menuText }]}>{phone}</Text>
            </View>
            <TouchableOpacity style={styles.centerCardCloseBtn} onPress={() => setProfileVisible(false)}>
              <Text style={styles.centerCardCloseText}>បិទ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* --- Settings --- */}
      <Modal visible={settingsVisible} animationType="fade" transparent onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.centerOverlay}>
          <View style={[styles.centerCard, { backgroundColor: c.menuBg }]}>
            <Text style={[styles.centerCardTitle, { color: c.menuText }]}>ការកំណត់</Text>
            <View style={styles.settingsRow}>
              <Text style={[styles.profileValue, { color: c.menuText }]}>🌙  Night Mode</Text>
              <Switch value={darkMode} onValueChange={setDarkMode} />
            </View>
            <TouchableOpacity style={styles.centerCardCloseBtn} onPress={() => setSettingsVisible(false)}>
              <Text style={styles.centerCardCloseText}>បិទ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* --- Groups --- */}
      <Modal visible={groupsVisible} animationType="slide" transparent onRequestClose={() => setGroupsVisible(false)}>
        <View style={styles.centerOverlay}>
          <View style={[styles.centerCard, { backgroundColor: c.menuBg, maxHeight: '75%' }]}>
            <Text style={[styles.centerCardTitle, { color: c.menuText }]}>ក្រុមជជែក (Groups)</Text>

            <FlatList
              data={rooms}
              keyExtractor={(r) => r.id}
              style={{ maxHeight: 260 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.roomRow} onPress={() => switchRoom(item.id)}>
                  <Text style={[styles.roomRowText, { color: c.menuText }, item.id === currentRoomId && styles.roomRowActive]}>
                    {item.id === currentRoomId ? '✓ ' : ''}
                    {item.name}
                  </Text>
                </TouchableOpacity>
              )}
            />

            <View style={[styles.sideMenuDivider, { backgroundColor: c.border, marginVertical: 12 }]} />

            <Text style={[styles.profileLabel, { color: c.subtleText, marginBottom: 6 }]}>បង្កើតក្រុមថ្មី</Text>
            <TextInput
              style={[styles.groupNameInputFull, { color: c.menuText, borderColor: c.border }]}
              value={newGroupName}
              onChangeText={setNewGroupName}
              placeholder="ឈ្មោះក្រុម"
              placeholderTextColor="#8e8e93"
              maxLength={40}
            />
            <TextInput
              style={[styles.groupNameInputFull, { color: c.menuText, borderColor: c.border, marginTop: 8 }]}
              value={newGroupMembers}
              onChangeText={setNewGroupMembers}
              placeholder="លេខទូរស័ព្ទសមាជិកបន្ថែម (ដកឃ្លាដោយសញ្ញា , )"
              placeholderTextColor="#8e8e93"
              keyboardType="phone-pad"
            />
            <TouchableOpacity style={styles.createGroupBtnFull} onPress={createGroup}>
              <Text style={styles.createGroupBtnText}>បង្កើតក្រុម</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.centerCardCloseBtn} onPress={() => setGroupsVisible(false)}>
              <Text style={styles.centerCardCloseText}>បិទ</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f2f7' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  menuIcon: { fontSize: 22 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, justifyContent: 'center' },
  headerLogo: { width: 26, height: 26, marginRight: 8 },
  headerTitle: { fontSize: 17, fontWeight: '700', maxWidth: 200 },
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#ff9500', paddingVertical: 6 },
  bannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  listContent: { padding: 12, paddingBottom: 8 },
  bubble: { maxWidth: '80%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 8 },
  bubbleMine: { backgroundColor: '#007aff', alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  bubbleSender: { fontSize: 11, fontWeight: '600', color: '#666', marginBottom: 2 },
  bubbleText: { fontSize: 16, color: '#000' },
  bubbleImage: { width: 200, height: 200, borderRadius: 12, marginTop: 2, marginBottom: 4, backgroundColor: '#d0d0d5' },
  fileChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 10, padding: 8, marginBottom: 4 },
  fileChipIcon: { fontSize: 20, marginRight: 6 },
  fileChipName: { fontSize: 14, color: '#fff', maxWidth: 160 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  attachBtn: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 8 },
  attachBtnText: { fontSize: 20 },
  recordingRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 16,
    height: 40,
    marginRight: 8,
  },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#ff3b30', marginRight: 8 },
  recordingTime: { fontSize: 15, fontWeight: '600', flex: 1 },
  recordingCancelBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  recordingCancelText: { color: '#ff3b30', fontWeight: '600', fontSize: 13 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, marginRight: 8 },
  sendBtn: { backgroundColor: '#007aff', borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10, justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#b5d6ff' },
  sendBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  loginContainer: { justifyContent: 'center', paddingHorizontal: 32 },
  loginTitle: { fontSize: 32, fontWeight: '700', textAlign: 'center', marginBottom: 8, color: '#000' },
  loginLogo: { width: 96, height: 96, alignSelf: 'center', marginBottom: 16 },
  loginSubtitle: { fontSize: 15, textAlign: 'center', color: '#666', marginBottom: 24 },
  phoneInput: { borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d1d1d6', paddingHorizontal: 16, paddingVertical: 14, fontSize: 18, textAlign: 'center' },
  errorText: { color: '#ff3b30', fontSize: 13, textAlign: 'center', marginTop: 8, marginBottom: 4 },
  loginBtn: { backgroundColor: '#007aff', borderRadius: 12, paddingVertical: 14, marginTop: 16 },
  loginBtnText: { color: '#fff', fontWeight: '700', fontSize: 17, textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', flexDirection: 'row' },
  sideMenu: { width: '75%', maxWidth: 300, height: '100%', paddingHorizontal: 20 },
  sideMenuName: { fontSize: 20, fontWeight: '700' },
  sideMenuPhone: { fontSize: 14, marginTop: 2, marginBottom: 16 },
  sideMenuDivider: { height: StyleSheet.hairlineWidth, marginBottom: 8 },
  sideMenuItem: { paddingVertical: 14 },
  sideMenuItemText: { fontSize: 16, fontWeight: '500' },
  centerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  centerCard: { width: '85%', borderRadius: 16, padding: 20 },
  centerCardTitle: { fontSize: 18, fontWeight: '700', marginBottom: 16 },
  profileRow: { marginBottom: 14 },
  profileLabel: { fontSize: 12, marginBottom: 2 },
  profileValue: { fontSize: 16, fontWeight: '600' },
  settingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  centerCardCloseBtn: { marginTop: 8, alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 16 },
  centerCardCloseText: { color: '#007aff', fontWeight: '600', fontSize: 15 },
  roomRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e5e5ea' },
  roomRowText: { fontSize: 15 },
  roomRowActive: { fontWeight: '700', color: '#007aff' },
  groupNameInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginRight: 8 },
  groupNameInputFull: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  createGroupBtn: { backgroundColor: '#007aff', borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  createGroupBtnFull: { backgroundColor: '#007aff', borderRadius: 10, paddingVertical: 12, marginTop: 10, alignItems: 'center' },
  createGroupBtnText: { color: '#fff', fontWeight: '600' },
});
