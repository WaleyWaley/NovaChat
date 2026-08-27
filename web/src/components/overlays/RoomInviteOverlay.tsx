/**
 * 语音房间邀请浮层 (对应 app.js showRoomInvite:785-792)
 * 复用 .call-overlay/.call-accept/.call-reject 的既有样式。
 */
import { useAppStore } from '../../store/useAppStore';
import { roomManager } from '../../managers/roomManager';

export default function RoomInviteOverlay() {
  const invite = useAppStore((s) => s.room.invite);
  const setRoomState = useAppStore((s) => s.setRoomState);

  if (!invite) return null;

  const onJoin = () => {
    setRoomState({ invite: null });
    roomManager.join(invite.roomId);
  };

  return (
    <div className="call-overlay">
      <div className="call-peer">🔊 {invite.fromName}</div>
      <div className="call-status">Invites you to a voice room</div>
      <div className="call-btns">
        <button className="call-accept" onClick={onJoin}>
          Join
        </button>
        <button className="call-reject" onClick={() => setRoomState({ invite: null })}>
          Decline
        </button>
      </div>
    </div>
  );
}
