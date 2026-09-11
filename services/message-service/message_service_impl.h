#pragma once

// =============================================================================
// NovaChat — MessageService 实现
//
// Phase 2.4: SendMessage + GetMessages
// Phase 2.5: 接入 PushDispatcher 实现实时推送
// Phase 3:   AckMessage (已读/送达) + GetSyncState (同步状态)
// Phase 4:   MySQL 持久化 (失败回退内存) + 已读回执推送
// Phase 4.2: GetDialogs / GetConversation (历史恢复)
// =============================================================================

#include "nova/common.h"
#include "nova/snowflake.h"
#include "message_dao.h"
#include "push_dispatcher.h"

// proto 生成的头文件
#include "nova/common/common.pb.h"
#include "nova/message/message.pb.h"
#include "nova/message/message.brpc.h"

namespace nova {
namespace message {

class MessageServiceImpl : public ::nova::message::MessageServiceBase {
public:
    MessageServiceImpl(nova::Snowflake* snowflake,
                       MessageDao* dao,
                       PushDispatcher* push);

    // ===== RPC 实现 =====

    void SendMessage(::google::protobuf::RpcController* controller,
                     const ::nova::message::SendMessageReq* request,
                     ::nova::message::SendMessageResp* response,
                     ::google::protobuf::Closure* done) override;

    void GetMessages(::google::protobuf::RpcController* controller,
                     const ::nova::message::GetMessagesReq* request,
                     ::nova::message::GetMessagesResp* response,
                     ::google::protobuf::Closure* done) override;

    void AckMessage(::google::protobuf::RpcController* controller,
                    const ::nova::message::AckMessageReq* request,
                    ::nova::message::AckMessageResp* response,
                    ::google::protobuf::Closure* done) override;

    void GetSyncState(::google::protobuf::RpcController* controller,
                      const ::nova::message::GetSyncStateReq* request,
                      ::nova::message::GetSyncStateResp* response,
                      ::google::protobuf::Closure* done) override;

    // Phase 4.2: 历史恢复
    void GetDialogs(::google::protobuf::RpcController* controller,
                    const ::nova::message::GetDialogsReq* request,
                    ::nova::message::GetDialogsResp* response,
                    ::google::protobuf::Closure* done) override;

    void GetConversation(::google::protobuf::RpcController* controller,
                         const ::nova::message::GetConversationReq* request,
                         ::nova::message::GetConversationResp* response,
                         ::google::protobuf::Closure* done) override;

private:
    // 参数校验
    bool ValidateSendRequest(const ::nova::message::SendMessageReq* req,
                             std::string* error);

    nova::Snowflake*    snowflake_;
    MessageDao*         dao_;
    PushDispatcher*     push_;
};

}  // namespace message
}  // namespace nova
